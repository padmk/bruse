// The `cua` object exposed in the REPL: browser inventory, browser selection and tab binding.

import { callBrowser, onBrowserEvent, sessionId } from "../browser-link.mjs";
import { BROWSER_DOCUMENTATION } from "./docs.mjs";
import { emitText } from "./output.mjs";
import { Tab } from "./tab.mjs";

const BROWSER_ID = "1";

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

const context = {
  call: (method, params) => callBrowser(method, params),
  waitForEvent,
};

// Browser organization through allow-listed WebExtensions methods, e.g. management.tabs.query({}).
function managementNamespace(namespace, methods) {
  return Object.fromEntries(methods.map((method) => [method, (...args) => callBrowser("browser.manage", { namespace, method, args })]));
}

const MANAGEMENT_DOCUMENTATION = `management: Chrome-compatible windows, tabs, tabGroups and bookmarks methods for organizing the
browser when the user asks for it. Arguments and results follow the chrome.* APIs.
- windows: getAll, get, getCurrent, getLastFocused, create, update, remove
- tabs: query, get, update, move, group, ungroup, remove, reload, duplicate, discard
- tabGroups: query, get, update, move
- bookmarks: search, getTree, getChildren, getRecent, get, create, update, move, remove, removeTree
Change only what the user asked for, confirm before deleting bookmarks or closing user tabs, and report what changed.`;

const capabilities = {
  management: {
    description: "Organize windows, tabs, tab groups and bookmarks.",
    documentation: async () => MANAGEMENT_DOCUMENTATION,
    windows: managementNamespace("windows", ["getAll", "get", "getCurrent", "getLastFocused", "create", "update", "remove"]),
    tabs: managementNamespace("tabs", ["query", "get", "update", "move", "group", "ungroup", "remove", "reload", "duplicate", "discard"]),
    tabGroups: managementNamespace("tabGroups", ["query", "get", "update", "move"]),
    bookmarks: managementNamespace("bookmarks", ["search", "getTree", "getChildren", "getRecent", "get", "create", "update", "move", "remove", "removeTree"]),
  },
};

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
// and notifications to report after each call.
export function createCua() {
  const tabs = new Map(); // tab id -> Tab
  const notifications = [];
  let documentationShown = false;
  let sessionName = null;

  const stopEvents = onBrowserEvent((event) => {
    if (!tabs.has(String(event.tabId))) return;
    if (event.method === "Page.windowOpen") notifications.push({ opener: event.tabId, url: event.params.url });
    else if (event.method === "Page.javascriptDialogOpening") {
      notifications.push(`Tab ${event.tabId} opened a JavaScript ${event.params.type} dialog: ${JSON.stringify(event.params.message)}. Handle it with getJsDialog().`);
    }
  });

  // Resolves new-window notifications to the tabs they created, matched by URL.
  async function takeNotifications() {
    const pending = notifications.splice(0);
    if (!pending.some((n) => typeof n !== "string")) return pending;
    const open = await callBrowser("tabs.list").catch(() => []);
    return pending.map((n) => {
      if (typeof n === "string") return n;
      const created = open.filter((tab) => tab.url === n.url && tab.id !== n.opener).sort((a, b) => b.id - a.id)[0];
      return created
        ? `Tab ${n.opener} opened a new tab ${created.id} (${n.url}); bind it with \`await cua.getTab("${created.id}")\`.`
        : `Tab ${n.opener} opened a new window for ${n.url}; find it with cua.listTabs().`;
    });
  }

  function bind(info) {
    const id = String(info.id);
    if (!tabs.has(id)) tabs.set(id, new Tab(context, info));
    return tabs.get(id);
  }

  async function browserInfo() {
    const { name } = await callBrowser("browser.info");
    return { id: BROWSER_ID, name, family: name.toLowerCase(), type: "extension" };
  }

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
    return (await callBrowser("tabs.list")).map(tabSummary);
  }

  async function getTab(reference, { browser } = {}) {
    checkBrowser(browser);
    let info;
    if (typeof reference === "object" && reference?.url) {
      const matches = (await callBrowser("tabs.list")).filter((tab) => tab.url === reference.url);
      if (matches.length !== 1) throw new Error(`Expected exactly one tab with URL ${reference.url}, found ${matches.length}`);
      [info] = matches;
    } else {
      const id = Number(typeof reference === "object" ? (reference.id ?? reference.mention) : reference);
      if (!Number.isInteger(id)) throw new Error(`Invalid tab reference ${JSON.stringify(reference)}`);
      info = await callBrowser("tabs.get", { tabId: id });
    }
    const tab = bind(info);
    return tab;
  }

  async function createBrowserTab(browserId, url, { sessionName: name } = {}) {
    checkBrowser(browserId);
    if (name) sessionName = name;
    const info = await callBrowser("tabs.create", { url, sessionId, sessionName });
    return bind(info);
  }

  function makeBrowser() {
    return {
      browserId: BROWSER_ID,
      documentation: async () => BROWSER_DOCUMENTATION,
      nameSession: async (name) => {
        sessionName = name;
        await callBrowser("session.name", { sessionId, name });
      },
      history: async ({ queries, from, to, limit = 100 } = {}) => {
        const search = async (text) =>
          callBrowser("history.search", {
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
        selected: async () => {
          const active = (await callBrowser("tabs.list")).find((tab) => tab.active);
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
      if (emit) emitText(JSON.stringify(result));
      return result;
    },
    async getBrowser({ id } = {}) {
      checkBrowser(id);
      showDocumentation();
      return makeBrowser();
    },
    async createBrowserTab(browserId, url, options = {}) {
      const tab = await createBrowserTab(browserId, url, options);
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
    dispose: stopEvents,
  };
}
