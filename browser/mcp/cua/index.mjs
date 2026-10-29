// The `cua` object exposed in the REPL: browser inventory, browser selection and tab binding.

import { MANAGEMENT_METHODS } from "../../extension/shared.js";
import { callBrowser, onBrowserEvent, sessionId } from "../browser-port.mjs";
import { PRODUCT_NAME, STORE_EXTENSION_ID, VERSION } from "../config.mjs";
import { BROWSER_DOCUMENTATION } from "./docs.mjs";
import { emitText } from "./output.mjs";
import { Tab } from "./tab.mjs";

const BROWSER_ID = "1";
const OPENED_TAB_WAIT_MS = 500;

function waitForEvent(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error("The expected browser event did not happen in time"));
    }, timeoutMs);
    const stop = onBrowserEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      stop();
      resolve(event);
    });
  });
}

const MANAGEMENT_DOCUMENTATION = `management: Chrome-compatible windows, tabs, tabGroups and bookmarks methods for organizing the
browser when the user asks for it. Arguments and results follow the chrome.* APIs.
${Object.entries(MANAGEMENT_METHODS)
  .map(([namespace, methods]) => `- ${namespace}: ${methods.join(", ")}`)
  .join("\n")}
In the default access mode, management sees only the tabs of this session and the tabs the user shared, and only
windows and groups that hold one. It changes, focuses, activates tabs in or moves tabs into only windows whose every
tab is this session's or shared. Tabs that windows.create and tabs.duplicate open are this session's, like those of
cua.createBrowserTab, and close when it ends; windows.create opens an unfocused window unless focused is set.
Change only what the user asked for, confirm before deleting bookmarks or closing user tabs, and report what changed.`;

// Browser organization through the allow-listed WebExtensions methods, e.g. management.tabs.query({}).
const createCapabilities = (call) => ({
  management: {
    description: "Organize windows, tabs, tab groups and bookmarks.",
    documentation: async () => MANAGEMENT_DOCUMENTATION,
    ...Object.fromEntries(
      Object.entries(MANAGEMENT_METHODS).map(([namespace, methods]) => [
        namespace,
        Object.fromEntries(methods.map((method) => [method, (...args) => call("browser.manage", { namespace, method, args })])),
      ]),
    ),
  },
});

function sameUrl(a, b) {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

function tabSummary(tab) {
  return {
    id: String(tab.id),
    browserId: BROWSER_ID,
    title: tab.title,
    url: tab.url,
    ...(tab.lastAccessed ? { lastOpened: new Date(tab.lastAccessed).toISOString() } : {}),
  };
}

// One instance per REPL session: tracks bound tabs (so element numbers persist), shown documentation
// and notifications to report after each call. After dispose() every browser call of the instance
// fails, so code left over from a reset REPL (timers, un-awaited promises) cannot act anymore.
export function createCua() {
  const tabs = new Map(); // tab id -> Tab
  const notifications = [];
  let documentationShown = false;
  let disposed = false;

  const call = (method, params) => {
    if (disposed) return Promise.reject(new Error("This REPL session was reset; its browser objects no longer work"));
    return callBrowser(method, params);
  };
  const context = { call, waitForEvent };
  const capabilities = createCapabilities(call);

  // Page.windowOpen says a page opened a window; the browser's report of the new tab (tabs.opened, with
  // the opening tab and URL) resolves it. Notifications keep their order; an opening is reported once
  // its tab is known, and one that no tab answers was blocked.
  const stopEvents = onBrowserEvent((event) => {
    if (!tabs.has(String(event.tabId))) return;
    if (event.method === "Page.windowOpen") notifications.push({ opener: event.tabId, url: event.params.url, tabId: null });
    else if (event.method === "tabs.opened") {
      const unresolved = notifications.filter((n) => typeof n === "object" && n.opener === event.tabId && n.tabId === null);
      const opening = unresolved.find((n) => sameUrl(n.url, event.params.url));
      // A tab the user opened from this page (its context menu) is none of the agent's business.
      if (opening) Object.assign(opening, { tabId: event.params.tabId, byAgent: event.params.byAgent });
      else if (event.params.byAgent) notifications.push({ opener: event.tabId, url: event.params.url, tabId: event.params.tabId, byAgent: true });
    } else if (event.method === "Page.javascriptDialogOpening") {
      notifications.push(`Tab ${event.tabId} opened a JavaScript ${event.params.type} dialog: ${JSON.stringify(event.params.message)}. Handle it with getJsDialog().`);
    }
  });

  async function takeNotifications() {
    // The new tab of an opening is usually known within moments.
    for (let waited = 0; waited < OPENED_TAB_WAIT_MS && notifications.some((n) => typeof n === "object" && n.tabId === null); waited += 50) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return notifications.splice(0).map((n) => {
      if (typeof n === "string") return n;
      return n.tabId !== null
        ? n.byAgent === false
          ? `Tab ${n.opener} opened a new tab ${n.tabId} (${n.url}) on its own, not from the agent's input; it is the user's tab, not part of this session.`
          : `Tab ${n.opener} opened a new tab ${n.tabId} (${n.url}); bind it with \`await cua.getTab("${n.tabId}")\`.`
        : `Tab ${n.opener} tried to open ${n.url}, but no new tab appeared (the browser may have blocked the popup); check with cua.listTabs().`;
    });
  }

  function bind(info) {
    const id = String(info.id);
    if (!tabs.has(id)) tabs.set(id, new Tab(context, info));
    return tabs.get(id);
  }

  async function browserInfo() {
    const { name, version, id: extensionId, access } = await call("browser.info");
    // After an update, a browser that still runs the previous extension, or an agent session started
    // before it, pairs two versions; the agent can tell the user how to bring them together.
    if (version !== VERSION && !versionWarned) {
      versionWarned = true;
      const remedy =
        extensionId === STORE_EXTENSION_ID
          ? "The browser updates the extension from the Chrome Web Store on its own; until then some calls may fail."
          : "Ask the user to run `bruse setup` (or the installer again) and start a new agent session; until then some calls may fail.";
      emitText(`Note: the ${PRODUCT_NAME} extension in the browser is ${version ? `version ${version}` : "an older version"}, but this MCP server is ${VERSION}. ${remedy}`);
    }
    return { id: BROWSER_ID, name, family: name.toLowerCase(), type: "extension", hiddenTabs: access?.hiddenTabs ?? 0 };
  }

  // Tabs that the user has not shared stay out of the lists; the agent learns how many there are and
  // how to ask for one.
  function hiddenTabsNote(count) {
    if (!count) return null;
    return `${count} other tab${count === 1 ? " is" : "s are"} open in the browser but not shared with agents. To work in one, ask the user to switch to it and click "Share this tab" in the ${PRODUCT_NAME} toolbar popup.`;
  }

  let versionWarned = false;

  function showDocumentation() {
    if (documentationShown) return;
    documentationShown = true;
    emitText(BROWSER_DOCUMENTATION);
  }

  function checkBrowser(id) {
    if (id !== undefined && String(id) !== BROWSER_ID && !/^(chrome|brave|browser|extension)$/i.test(String(id))) {
      throw new Error(`Unknown browser "${id}"; the connected browser is "${BROWSER_ID}"`);
    }
  }

  async function listTabs() {
    return (await call("tabs.list")).map(tabSummary);
  }

  async function getTab(reference, { browser } = {}) {
    checkBrowser(browser);
    let info;
    if (typeof reference === "object" && reference?.url) {
      const matches = (await call("tabs.list")).filter((tab) => tab.url === reference.url);
      if (matches.length !== 1) {
        const note = matches.length ? null : hiddenTabsNote((await browserInfo()).hiddenTabs);
        throw new Error(`Expected exactly one tab with URL ${reference.url}, found ${matches.length}.${note ? ` ${note}` : ""}`);
      }
      [info] = matches;
    } else {
      const id = Number(typeof reference === "object" ? (reference.id ?? reference.mention) : reference);
      if (!Number.isInteger(id)) throw new Error(`Invalid tab reference ${JSON.stringify(reference)}`);
      info = await call("tabs.get", { tabId: id });
    }
    const tab = bind(info);
    return tab;
  }

  async function createBrowserTab(browserId, url) {
    checkBrowser(browserId);
    const info = await call("tabs.create", { url, sessionId });
    return bind(info);
  }

  function makeBrowser() {
    return {
      browserId: BROWSER_ID,
      documentation: async () => BROWSER_DOCUMENTATION,
      history: async ({ queries, from, to, limit = 100 } = {}) => {
        const search = async (text) =>
          call("history.search", {
            text,
            startTime: from ? new Date(from).getTime() : 0,
            endTime: to ? new Date(to).getTime() : undefined,
            maxResults: limit,
          });
        const results = queries?.length ? (await Promise.all(queries.map(search))).flat() : await search("");
        const unique = [...new Map(results.map((entry) => [entry.url, entry])).values()];
        return unique
          .sort((a, b) => b.lastVisitTime - a.lastVisitTime)
          .slice(0, limit)
          .map((entry) => ({ url: entry.url, title: entry.title, dateVisited: new Date(entry.lastVisitTime).toISOString() }));
      },
      tabs: {
        list: listTabs,
        get: (id) => getTab(id),
        new: () => createBrowserTab(BROWSER_ID),
        // Every window has an active tab; the selected one is in the window the user used last.
        selected: async () => {
          const active = await call("tabs.selected");
          return active ? bind(active) : undefined;
        },
      },
      user: {
        openTabs: async () => (await listTabs()).sort((a, b) => (b.lastOpened ?? "").localeCompare(a.lastOpened ?? "")),
        claimTab: (tab) => getTab(typeof tab === "object" ? tab.id : tab),
      },
      capabilities: {
        list: async () => Object.entries(capabilities).map(([id, capability]) => ({ id, description: capability.description })),
        get: async (id) => {
          if (!capabilities[id]) throw new Error(`Browser capability "${id}" is not available`);
          return capabilities[id];
        },
      },
    };
  }

  const cua = {
    async getState({ emit = true } = {}) {
      const browser = await browserInfo();
      const state = { apps: [], browsers: [{ ...browser, tabs: await listTabs() }] };
      if (emit) {
        showDocumentation();
        emitText(JSON.stringify(state));
        const note = hiddenTabsNote(browser.hiddenTabs);
        if (note) emitText(note);
      }
      return state;
    },
    async initialize() {
      return cua.getState();
    },
    async listBrowsers({ emit = true } = {}) {
      const browsers = [await browserInfo()];
      if (emit) emitText(JSON.stringify(browsers));
      return browsers;
    },
    async listTabs({ browser, emit = true } = {}) {
      checkBrowser(browser);
      const result = await listTabs();
      if (emit) {
        emitText(JSON.stringify(result));
        const note = hiddenTabsNote((await browserInfo()).hiddenTabs);
        if (note) emitText(note);
      }
      return result;
    },
    async getBrowser({ id } = {}) {
      checkBrowser(id);
      showDocumentation();
      return makeBrowser();
    },
    async createBrowserTab(browserId, url, options = {}) {
      const tab = await createBrowserTab(browserId, url);
      showDocumentation();
      if (options.emit !== false) await tab.getAXState();
      return tab;
    },
    async getTab(reference, options = {}) {
      const tab = await getTab(reference, options);
      showDocumentation();
      if (options.emit === false) return tab;
      const url = await tab.url();
      // New-tab pages carry no content worth reading.
      if (/^(chrome|brave):\/\/newtab\/?$/.test(url ?? "")) emitText(`Browser tab: ${tab.id}, Title: "New Tab", URL: ${JSON.stringify(url)}. Use tab.goto(url) to load a page.`);
      else await tab.getAXState();
      return tab;
    },
    async rewriteDocumentation() {
      documentationShown = false;
      showDocumentation();
    },
  };

  return {
    cua,
    takeNotifications,
    dispose() {
      disposed = true;
      stopEvents();
    },
  };
}
