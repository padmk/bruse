// Executes requests from the local MCP hub, which reach it through the offscreen document: tab
// lifecycle, agent tab groups, raw CDP commands, browser management, history and downloads. Page
// logic lives in the MCP server.

import { cdp, consoleLogs, detach, networkRequests, onCdpEvent, tabState } from "./cdp.js";
import { waitForDownload } from "./downloads.js";
import { agentTabs, endSession, groupAgentTab, markTab, nameSession, onTabOpened } from "./sessions.js";

const OFFSCREEN_ALARM = "offscreen-check";
const MANAGEMENT_METHODS = {
  windows: ["getAll", "get", "getCurrent", "getLastFocused", "create", "update", "remove"],
  tabs: ["query", "get", "update", "move", "group", "ungroup", "remove", "reload", "duplicate", "discard"],
  tabGroups: ["query", "get", "update", "move"],
  bookmarks: ["search", "getTree", "getChildren", "getRecent", "get", "create", "update", "move", "remove", "removeTree"],
};
const LOAD_TIMEOUT_MS = 20_000;
// CDP events the MCP server reacts to; the rest stay inside the extension.
const FORWARDED_EVENTS = new Set(["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened", "Page.windowOpen"]);

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title,
    url: tab.url,
    groupId: tab.groupId,
    lastAccessed: tab.lastAccessed,
    pendingUrl: tab.pendingUrl,
    status: tab.status,
  };
}

// Resolves with whether the tab finished loading; slow pages are returned as they are after the timeout.
function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const done = (loaded) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(loaded);
    };
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && done(true), () => done(false));
  });
}

function browserName() {
  const brands = navigator.userAgentData?.brands?.map((brand) => brand.brand) ?? [];
  return brands.find((brand) => !/Chromium|Not.?A.?Brand/i.test(brand)) ?? "Chromium";
}

const handlers = {
  "browser.info": async () => ({ name: browserName(), userAgent: navigator.userAgent }),

  "tabs.list": async () => (await chrome.tabs.query({})).map(tabInfo),

  "tabs.get": async ({ tabId }) => tabInfo(await chrome.tabs.get(tabId)),

  "tabs.create": async ({ url, sessionId, sessionName }) => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    const tab = await chrome.tabs.create({ url: url ?? "about:blank", windowId: window.id, active: false });
    await groupAgentTab(tab.id, sessionId, sessionName);
    if (url) await waitForLoad(tab.id);
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  // CDP navigation reports blocked or failed loads instead of silently keeping the old page.
  "tabs.navigate": async ({ tabId, url }) => {
    const { errorText } = await cdp(tabId, "Page.navigate", { url });
    if (errorText) throw new Error(`Navigation to ${url} failed: ${errorText}`);
    await waitForLoad(tabId);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  "tabs.history": async ({ tabId, direction }) => {
    if (direction === "back") await chrome.tabs.goBack(tabId);
    else if (direction === "forward") await chrome.tabs.goForward(tabId);
    else await chrome.tabs.reload(tabId);
    await waitForLoad(tabId);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  "tabs.waitForLoad": async ({ tabId, timeoutMs }) => ({ loaded: await waitForLoad(tabId, timeoutMs) }),

  "tabs.close": async ({ tabId }) => {
    await detach(tabId);
    await chrome.tabs.remove(tabId);
    return null;
  },

  "tabs.mark": ({ tabId, mark }) => markTab(tabId, mark),
  "tabs.agent": () => agentTabs(),
  "session.name": ({ sessionId, name }) => nameSession(sessionId, name),
  "session.end": ({ sessionId }) => endSession(sessionId),

  cdp: ({ tabId, method, params, sessionId, timeoutMs }) => cdp(tabId, method, params, sessionId, timeoutMs),
  "page.state": ({ tabId }) => tabState(tabId),
  "page.console": ({ tabId }) => consoleLogs(tabId),
  "page.network": ({ tabId }) => networkRequests(tabId),

  "history.search": ({ text = "", startTime, endTime, maxResults = 100 }) =>
    chrome.history.search({ text, startTime, endTime, maxResults }),

  "downloads.wait": ({ tabId, timeoutMs = 120_000 }) => waitForDownload(tabId, timeoutMs),

  // Browser organization through the WebExtensions APIs; only listed methods can be called.
  "browser.manage": ({ namespace, method, args = [] }) => {
    if (!MANAGEMENT_METHODS[namespace]?.includes(method)) throw new Error(`${namespace}.${method} is not available`);
    // Organizing tabs must not navigate them; pages are opened and driven through tab objects.
    if (namespace === "tabs" && method === "update" && args[1] && "url" in args[1]) throw new Error("management.tabs.update cannot change a tab's URL; bind the tab with cua.getTab and use tab.goto");
    return chrome[namespace][method](...args);
  },

  // Picks up edited extension files without visiting the extensions page.
  "extension.reload": () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return null;
  },
};

// Hub authentication. On first use the extension pairs with the hub by sending it a random secret,
// which the hub stores; later connections prove knowledge of that secret in both directions with
// HMAC over fresh nonces, so neither a local process posing as the hub nor one posing as the extension
// can take over. Requests are executed only on the authenticated connection.
let hub = { gen: 0, verified: false, expectedHubMac: null };

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(length = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

async function answerChallenge(nonce) {
  const { hubSecret } = await chrome.storage.local.get("hubSecret");
  const ownNonce = randomHex();
  if (!hubSecret) {
    const secret = randomHex();
    await chrome.storage.local.set({ hubSecret: secret });
    hub.expectedHubMac = await hmac(secret, `hub:${ownNonce}`);
    return { type: "pair", secret, nonce: ownNonce };
  }
  hub.expectedHubMac = await hmac(hubSecret, `hub:${ownNonce}`);
  return { type: "auth", mac: await hmac(hubSecret, `extension:${nonce}`), nonce: ownNonce };
}

let reconnectRequestedFor = 0;
function requestReconnect(gen) {
  if (reconnectRequestedFor === gen) return;
  reconnectRequestedFor = gen;
  chrome.runtime.sendMessage({ target: "offscreen", type: "reconnect", gen }).catch(() => {});
}

// Sends a message to the authenticated hub through the offscreen document.
function send(message) {
  if (!hub.verified) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "send", gen: hub.gen, data: JSON.stringify(message) }).catch(() => {});
}

async function handle(gen, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!message || typeof message !== "object") return null;
  if (gen !== hub.gen) hub = { gen, verified: false, expectedHubMac: null };
  if (message.type === "challenge") return JSON.stringify(await answerChallenge(String(message.nonce)));
  if (message.type === "auth-ok") {
    hub.verified = Boolean(hub.expectedHubMac) && message.mac === hub.expectedHubMac;
    return null;
  }
  const { id, method, params } = message;
  // A restarted service worker has lost the authentication of an open connection; reconnecting makes
  // the hub authenticate again.
  if (!hub.verified) requestReconnect(gen);
  if (id === undefined) return null; // keepalive
  if (!hub.verified) return JSON.stringify({ id, error: "The browser connection is being authenticated again; retry the call" });
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    return JSON.stringify({ id, result: (await handler(params ?? {})) ?? null });
  } catch (error) {
    return JSON.stringify({ id, error: error?.message ?? String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "worker") return false;
  if (message.type === "hub-open" || message.type === "hub-closed") {
    if (message.gen >= hub.gen) hub = { gen: message.gen, verified: false, expectedHubMac: null };
    return false;
  }
  if (message.type !== "hub-message") return false;
  handle(message.gen, message.data).then(sendResponse);
  return true;
});

onCdpEvent((tabId, method, params, sessionId) => {
  if (FORWARDED_EVENTS.has(method)) send({ type: "event", tabId, method, params, sessionId });
});

// Tells sessions which tab a page opened, so that notifications name the exact tab.
onTabOpened((openerTabId, tabId, url, byAgent) => send({ type: "event", tabId: openerTabId, method: "tabs.opened", params: { tabId, url, byAgent } }));

async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen
    .createDocument({ url: "offscreen.html", reasons: ["WORKERS"], justification: "Keeps the connection to local agent sessions open" })
    .catch((error) => {
      if (!/single offscreen/i.test(error.message)) throw error;
    });
}

// Debugger sessions this extension still holds from before a service worker restart have lost their
// tracked state (and would never be detached when idle); start them over.
chrome.debugger.getTargets().then((targets) => {
  for (const target of targets) if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(() => {});
});

// The offscreen document reconnects on its own; this only recreates it if the browser closed it.
chrome.alarms.create(OFFSCREEN_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => name === OFFSCREEN_ALARM && ensureOffscreenDocument());
chrome.runtime.onStartup.addListener(ensureOffscreenDocument);
chrome.runtime.onInstalled.addListener(ensureOffscreenDocument);
ensureOffscreenDocument();
