// Executes requests from the local MCP hub, which reach it through the offscreen document: tab
// lifecycle, agent tab groups, raw CDP commands, browser management, history and downloads. Page
// logic lives in the MCP server.

import { ALL_TABS, accessMode, anyoneMayAccess, audienceOf, bothAudiences, endShareOfClosedTab, mayAccess, requireAccess, requireOwnWindow, seesWindow, visibleTabs } from "./access.js";
import { EXTENSION_WORK, attachedTabIds, cdp, consoleLogs, detach, networkRequests, onCdpEvent, setDebugGate, tabState } from "./cdp.js";
import { waitForDownload } from "./downloads.js";
import { PAUSED_ERROR, isPaused } from "./pause.js";
import { agentTabs, createAgentTab, createAgentTabs, endSession, markTab, noteAgentInput, onTabOpened, openingSession, setLiveSessions } from "./sessions.js";
import { checkRequest } from "./guard.js";
import { fromExtensionPage } from "./sender.js";
import { MANAGEMENT_METHODS, extensionBuild, isPressInput } from "./shared.js";

// Content scripts that this extension runs in pages (see cdp.js) get no access to its storage, which
// holds the access setting, the shares and the hub secret. Session storage starts out this way.
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

const OFFSCREEN_ALARM = "offscreen-check";
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

// History and bookmarks are optional permissions that the user turns on in the popup.
async function requirePermission(permission, what) {
  if (await chrome.permissions.contains({ permissions: [permission] })) return;
  const name = chrome.runtime.getManifest().name;
  throw new Error(`The user has not given ${name} access to ${what}. Tell the user; they can turn it on in the ${name} popup in the browser toolbar.`);
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

// The fingerprint of the code this extension runs (see shared.js), computed once per worker start.
const build = extensionBuild((file) => fetch(chrome.runtime.getURL(file)).then((response) => response.text())).catch(() => ({ hash: null }));

// Each handler gets the request's parameters and `session`, the agent session the hub says the request
// comes from. Tab methods check access first (see access.js).
const handlers = {
  "browser.info": async (_, session) => {
    const mode = await accessMode();
    const { hidden } = await visibleTabs(session, await chrome.tabs.query({}));
    return { name: browserName(), userAgent: navigator.userAgent, version: chrome.runtime.getManifest().version, build: (await build).hash, id: chrome.runtime.id, paused: await isPaused(), access: { mode, hiddenTabs: hidden } };
  },

  "tabs.list": async (_, session) => (await visibleTabs(session, await chrome.tabs.query({}))).shown.map(tabInfo),

  "tabs.get": async ({ tabId }) => tabInfo(await chrome.tabs.get(tabId)),

  // The active tab of the window the user used last, when the session may use it.
  "tabs.selected": async (_, session) => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const [tab] = window ? await chrome.tabs.query({ windowId: window.id, active: true }) : [];
    return tab && (await mayAccess(session, tab.id)) ? tabInfo(tab) : null;
  },

  "tabs.create": async ({ url }, session) => {
    const tab = await createAgentTab(session, async () => {
      const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
      return chrome.tabs.create({ url: url ?? "about:blank", windowId: window.id, active: false });
    });
    if (url) await waitForLoad(tab.id);
    return tabInfo(await chrome.tabs.get(tab.id));
  },

  // CDP navigation reports blocked or failed loads instead of silently keeping the old page.
  "tabs.navigate": async ({ tabId, url }, session) => {
    const { errorText } = await cdp(tabId, "Page.navigate", { url }, undefined, undefined, { session });
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
  // The session's own tabs and their marks.
  "tabs.agent": async (_, session) => Object.fromEntries(Object.entries(await agentTabs()).filter(([, entry]) => entry.sessionId === session)),
  "session.end": (_, session) => endSession(session),

  cdp: ({ tabId, method, params, sessionId, timeoutMs }, session) => {
    if (isPressInput(method, params)) noteAgentInput(tabId, session);
    return cdp(tabId, method, params, sessionId, timeoutMs, { session });
  },
  "page.state": ({ tabId }, session) => tabState(tabId, { session }),
  "page.console": ({ tabId }) => consoleLogs(tabId),
  "page.network": ({ tabId }) => networkRequests(tabId),

  "history.search": async ({ text = "", startTime, endTime, maxResults = 100 }) => {
    await requirePermission("history", "the browsing history");
    return chrome.history.search({ text, startTime, endTime, maxResults });
  },

  "downloads.wait": ({ tabId, timeoutMs = 120_000 }, session) => waitForDownload(tabId, timeoutMs, { session }),

  // Browser organization through the WebExtensions APIs; only listed methods can be called.
  "browser.manage": async ({ namespace, method, args = [] }, session) => {
    if (!MANAGEMENT_METHODS[namespace]?.includes(method)) throw new Error(`${namespace}.${method} is not available`);
    if (namespace === "bookmarks") await requirePermission("bookmarks", "the bookmarks");
    checkManagementArguments(namespace, method, args);
    const call = await withDefaults(namespace, method, args);
    await checkManagementAccess(session, namespace, method, call);
    const opening = OPENING_METHODS[`${namespace}.${method}`];
    return withoutHiddenTabs(session, namespace, await (opening ? opening(session, call) : chrome[namespace][method](...call)));
  },

  // Picks up edited extension files without visiting the extensions page.
  "extension.reload": () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return null;
  },
};

// Methods that need the tab's loaded page, which a tab the browser discarded to free memory no longer
// has; tabs.navigate and tabs.history load a new one. Checked after access, so that only a tab the
// session may use is reported as discarded.
const LOADED_PAGE_METHODS = new Set(["cdp", "page.state", "page.console", "page.network", "downloads.wait"]);
const DISCARDED = "The browser discarded this tab to free memory, so its page and anything typed into it are gone. Load it again with tab.reload() or tab.goto(url), then read the state.";

// Methods that act on the tab in params.tabId.
const TAB_METHODS = new Set(["tabs.get", "tabs.navigate", "tabs.history", "tabs.waitForLoad", "tabs.close", "tabs.mark", "cdp", "page.state", "page.console", "page.network", "downloads.wait"]);

// Management tab methods and how their first argument names tabs. Chrome lets several of them leave the
// tab out and act on the selected tab instead; agents must name it, so every target is checked.
const TAB_ARGUMENTS = {
  get: "id",
  update: "id",
  reload: "id",
  duplicate: "id",
  discard: "id",
  move: "ids",
  ungroup: "ids",
  remove: "ids",
  group: "options",
};

function isTabId(value) {
  return Number.isInteger(value) && value >= 0;
}

// The tabs a management call acts on, from arguments that name them explicitly.
function tabIdsOf(method, args) {
  const [first] = args;
  const ids = TAB_ARGUMENTS[method] === "id" ? [first] : TAB_ARGUMENTS[method] === "ids" ? [first].flat() : [first?.tabIds].flat();
  if (!ids.length || !ids.every(isTabId)) throw new Error(`management.tabs.${method} needs the ID${TAB_ARGUMENTS[method] === "id" ? "" : "s"} of the tab${TAB_ARGUMENTS[method] === "id" ? "" : "s"} it acts on`);
  return ids;
}

// Checks that hold in every access mode: tab methods name their tabs, and organizing tabs never
// navigates them (pages are opened and driven through tab objects).
function checkManagementArguments(namespace, method, args) {
  if (namespace === "tabs" && TAB_ARGUMENTS[method]) tabIdsOf(method, args);
  if (namespace === "windows" && method === "create" && args[0] !== undefined && (typeof args[0] !== "object" || args[0] === null)) throw new Error("management.windows.create takes an object of properties");
  if (namespace === "tabs" && method === "update" && (args[1] === undefined || (typeof args[1] === "object" && args[1] !== null && "url" in args[1]))) {
    throw new Error("management.tabs.update takes a tab ID and properties without url; bind the tab with cua.getTab and use tab.goto to navigate");
  }
}

// Arguments that keep management in the background and predictable: a new window opens unfocused
// unless the caller says otherwise (a maximized or fullscreen window cannot open unfocused), and a new
// group opens in the window of its first tab instead of the browser's current window.
async function withDefaults(namespace, method, args) {
  const [first, ...rest] = args;
  if (namespace === "windows" && method === "create" && !["maximized", "fullscreen"].includes(first?.state)) return [{ focused: false, ...first }, ...rest];
  if (namespace === "tabs" && method === "group" && first.groupId === undefined && first.createProperties?.windowId === undefined) {
    const { windowId } = await chrome.tabs.get(tabIdsOf(method, args)[0]);
    return [{ ...first, createProperties: { ...first.createProperties, windowId } }, ...rest];
  }
  return args;
}

// Management calls may act only on tabs and groups whose tabs the session may reach, and change, switch
// tabs in or move tabs into only the session's own windows (see access.js).
async function checkManagementAccess(session, namespace, method, args) {
  if ((await accessMode()) === ALL_TABS) return;
  const requireTabs = async (tabs) => {
    for (const tabId of tabs) await requireAccess(session, tabId);
  };
  const groupTabs = async (groupId) => (await chrome.tabs.query({ groupId })).map((tab) => tab.id);
  // Tabs that leave their window for `windowId` move into it, which must be the session's.
  const requireMoveInto = async (tabIds, windowId) => {
    const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
    if (tabs.some((tab) => tab.windowId !== windowId)) await requireOwnWindow(session, windowId);
  };
  const [first, second] = args;
  if (namespace === "tabs" && TAB_ARGUMENTS[method]) await requireTabs(tabIdsOf(method, args));
  // Activating or highlighting a tab switches what the user sees in its window, and so can unhighlighting
  // the active tab, which activates another highlighted one.
  if (namespace === "tabs" && method === "update" && ["active", "highlighted", "selected"].some((key) => second?.[key] !== undefined)) await requireOwnWindow(session, (await chrome.tabs.get(first)).windowId);
  if (namespace === "tabs" && method === "move" && second?.windowId !== undefined) await requireMoveInto(tabIdsOf(method, args), second.windowId);
  if (namespace === "tabs" && method === "group") {
    if (first.groupId !== undefined) {
      // Joining a group changes it, so the session must reach every tab in it.
      await requireTabs(await groupTabs(first.groupId));
      await requireMoveInto(tabIdsOf(method, args), (await chrome.tabGroups.get(first.groupId)).windowId);
    } else {
      await requireMoveInto(tabIdsOf(method, args), first.createProperties.windowId);
    }
  }
  // A new window may take an existing tab, which moves it.
  if (namespace === "windows" && method === "create" && first.tabId !== undefined) await requireTabs([first.tabId]);
  if (namespace === "windows" && (method === "update" || method === "remove")) await requireOwnWindow(session, first);
  if (namespace === "tabGroups" && (method === "update" || method === "move")) await requireTabs(await groupTabs(first));
  if (namespace === "tabGroups" && method === "move" && second?.windowId !== undefined && second.windowId !== (await chrome.tabGroups.get(first)).windowId) {
    await requireOwnWindow(session, second.windowId);
  }
}

// Management calls that open tabs. Like tabs.create, in every access mode, they open the tabs for the
// session: its own, in the agent group, closed when it ends.
const OPENING_METHODS = {
  // The duplicate is the session's; the original keeps its owner or share. The browser activates a
  // duplicate, so the tab that was active in its window becomes active again.
  "tabs.duplicate": async (session, [tabId]) => {
    const { windowId } = await chrome.tabs.get(tabId);
    const [active] = await chrome.tabs.query({ windowId, active: true });
    const [duplicate] = await createAgentTabs(session, async () => [await chrome.tabs.duplicate(tabId)]);
    if (active && active.id !== duplicate.id) await chrome.tabs.update(active.id, { active: true }).catch(() => {});
    return chrome.tabs.get(duplicate.id);
  },
  // A tab moved into the new window with `tabId` keeps its owner or share; the others are new.
  "windows.create": async (session, [options]) => {
    let window;
    await createAgentTabs(session, async () => {
      window = await chrome.windows.create(options);
      return (await chrome.tabs.query({ windowId: window.id })).filter((tab) => tab.id !== options.tabId);
    });
    return chrome.windows.get(window.id, { populate: true });
  },
};

// Tabs the session may not reach are left out of management results, and so are windows and groups
// without any tab it may reach.
async function withoutHiddenTabs(session, namespace, result) {
  if ((await accessMode()) === ALL_TABS) return result;
  const filterTabs = async (tabs) => (await visibleTabs(session, tabs)).shown;
  if (namespace === "tabs" && Array.isArray(result)) return filterTabs(result);
  if (namespace === "tabs" && result && typeof result === "object" && isTabId(result.id) && !(await filterTabs([result])).length) {
    throw new Error("This tab is not one of this session's tabs, and the user has not shared it");
  }
  if (namespace === "windows" && result && typeof result === "object") {
    const filterWindow = async (window) => (Array.isArray(window.tabs) ? { ...window, tabs: await filterTabs(window.tabs) } : window);
    if (Array.isArray(result)) {
      const shown = [];
      for (const window of result) if (await seesWindow(session, window.id)) shown.push(await filterWindow(window));
      return shown;
    }
    if (!(await seesWindow(session, result.id))) throw new Error("This window holds no tab of this session or shared by the user");
    return filterWindow(result);
  }
  if (namespace === "tabGroups") {
    const visible = async (group) => (await filterTabs(await chrome.tabs.query({ groupId: group.id }))).length > 0;
    if (Array.isArray(result)) {
      const shown = [];
      for (const group of result) if (await visible(group)) shown.push(group);
      return shown;
    }
    if (result && !(await visible(result))) throw new Error("This tab group holds no tab of this session or shared by the user");
  }
  return result;
}

// The debugger acts for an agent's request only while that request's session may use the tab, and for the
// extension's own work (downloads) only while some session may.
setDebugGate((tabId, caller) => (caller === EXTENSION_WORK ? anyoneMayAccess(tabId) : mayAccess(caller.session, tabId)));

// A tab no session may reach keeps no debugger attached: after the user stops sharing it, switches to
// "agent tabs" or a session ends, it is detached at once.
async function detachUnreachable() {
  for (const tabId of attachedTabIds()) if (!(await anyoneMayAccess(tabId))) await detach(tabId);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "session" && "sharedTabs" in changes) || (area === "local" && "accessMode" in changes)) detachUnreachable();
});
// A share ends with its tab.
chrome.tabs.onRemoved.addListener((tabId) => endShareOfClosedTab(tabId));

// A hub of a version before tab ownership sends requests without the session they come from.
const OUTDATED_HUB = `The ${chrome.runtime.getManifest().name} MCP server that relays this request is older than the browser extension and does not say which agent session it comes from. Ask the user to run \`bruse setup\` and start new agent sessions.`;
const SESSIONLESS_METHODS = new Set(["browser.info", "extension.reload"]);

// Requests that still run while the user has paused agents: browser.info only reads the state, and
// session.end closes no tab while paused (sessions.js closes the session's tabs when the user resumes).
// extension.reload is refused, because a reload would end the user's tab shares.
const PAUSE_EXEMPT = new Set(["browser.info", "session.end"]);

// Hub authentication. On first use the extension pairs with the hub by sending it a random secret,
// which the hub stores; later connections prove knowledge of that secret in both directions with
// HMAC over fresh nonces, so neither a local process posing as the hub nor one posing as the extension
// can take over. Requests are executed only on the authenticated connection.
const unverifiedHub = (gen) => ({ gen, verified: false, expectedHubMac: null, pairing: null });
let hub = unverifiedHub(0);

// A new connection, or none: its hub has yet to authenticate and to report the live sessions.
function resetHub(gen) {
  hub = unverifiedHub(gen);
  setLiveSessions(null);
}

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
    // The secret becomes the paired one only when the hub proves it stored it (auth-ok). Until then the
    // same pending secret is offered again, so a hub that refused it can still accept it later.
    let { pendingHubSecret: secret } = await chrome.storage.local.get("pendingHubSecret");
    if (!secret) {
      secret = randomHex();
      await chrome.storage.local.set({ pendingHubSecret: secret });
    }
    hub.expectedHubMac = await hmac(secret, `hub:${ownNonce}`);
    hub.pairing = secret;
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
  if (gen !== hub.gen) resetHub(gen);
  if (message.type === "challenge") return JSON.stringify(await answerChallenge(String(message.nonce)));
  if (message.type === "auth-ok") {
    hub.verified = Boolean(hub.expectedHubMac) && message.mac === hub.expectedHubMac;
    if (hub.verified && hub.pairing) {
      await chrome.storage.local.set({ hubSecret: hub.pairing });
      await chrome.storage.local.remove("pendingHubSecret");
      hub.pairing = null;
    }
    return null;
  }
  const { id, method, params, session } = message;
  // A restarted service worker has lost the authentication of an open connection; reconnecting makes
  // the hub authenticate again.
  if (!hub.verified) requestReconnect(gen);
  if (message.type === "live-sessions") {
    if (hub.verified && Array.isArray(message.sessionIds)) setLiveSessions(message.sessionIds.filter((sessionId) => typeof sessionId === "string"));
    return null;
  }
  if (id === undefined) return null; // keepalive
  if (!hub.verified) return JSON.stringify({ id, error: "The browser connection is being authenticated again; retry the call" });
  try {
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method ${method}`);
    if (!PAUSE_EXEMPT.has(method) && (await isPaused())) throw new Error(PAUSED_ERROR);
    if (!SESSIONLESS_METHODS.has(method) && !("session" in message)) throw new Error(OUTDATED_HUB);
    // Access comes first, so a request for a hidden tab learns nothing about the tab's page.
    if (TAB_METHODS.has(method)) await requireAccess(session, params?.tabId);
    await checkRequest(method, params ?? {});
    if (LOADED_PAGE_METHODS.has(method) && (await chrome.tabs.get(params.tabId).catch(() => null))?.discarded) throw new Error(DISCARDED);
    return JSON.stringify({ id, result: (await handler(params ?? {}, session)) ?? null });
  } catch (error) {
    return JSON.stringify({ id, error: error?.message ?? String(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "worker" || !fromExtensionPage(sender)) return false;
  if (message.type === "hub-open" || message.type === "hub-closed") {
    if (message.gen >= hub.gen) resetHub(message.gen);
    return false;
  }
  if (message.type !== "hub-message") return false;
  handle(message.gen, message.data).then(sendResponse);
  return true;
});

// Events go only to the sessions that may use their tab now (`audience`, null for all); the hub routes
// them. An event no session may see is not sent. Working out the audience takes storage reads, so events
// pass through one queue and keep their order.
let eventQueue = Promise.resolve();
function sendEvent(event, audience) {
  eventQueue = eventQueue
    .then(async () => {
      const recipients = await audience();
      if (recipients === null || recipients.length) send({ ...event, type: "event", audience: recipients });
    })
    .catch(() => {});
}

// A page's request to open a window names the address of the tab it opens, which belongs to whoever
// caused the opening: from a shared tab it goes only to the session whose input caused it (fixed now,
// as sessions.js does for ownership), and to nobody when that is not one session.
async function openingAudience(tabId, initiator) {
  const audience = await audienceOf(tabId);
  if (audience !== null || (await accessMode()) === ALL_TABS) return audience;
  return initiator ? [initiator] : [];
}

onCdpEvent((tabId, method, params, sessionId) => {
  if (!FORWARDED_EVENTS.has(method)) return;
  if (method === "Page.windowOpen") {
    // The initiator is read at once, before any input that arrives while the audience is worked out.
    const audience = openingAudience(tabId, openingSession(tabId));
    sendEvent({ tabId, method, params, sessionId }, () => audience);
  } else {
    sendEvent({ tabId, method, params, sessionId }, () => audienceOf(tabId));
  }
});

// Tells sessions which tab a page opened, so that notifications name the exact tab.
// An opening is reported to the sessions that may use both the opening tab and the new one; openings in
// the user's own tabs are not reported.
onTabOpened((openerTabId, tabId, url, byAgent) => {
  sendEvent({ tabId: openerTabId, method: "tabs.opened", params: { tabId, url, byAgent } }, async () => bothAudiences(await audienceOf(openerTabId), await audienceOf(tabId)));
});

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
