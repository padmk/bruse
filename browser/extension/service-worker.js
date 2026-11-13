// Executes requests from the local MCP hub, which reach it through the offscreen document: tab
// lifecycle, agent tab groups, raw CDP commands, browser management, history and downloads. Page
// logic lives in the MCP server.

import { ALL_TABS, accessMode, anyoneMayAccess, audienceOf, bothAudiences, endShareOfClosedTab, mayAccess, requireAccess, requireOwnTab, requireOwnWindow, seesWindow, visibleTabs } from "./access.js";
import { EXTENSION_WORK, attachedTabIds, cdp, closeTab, consoleLogs, detach, hasNoPage, networkRequests, onCdpEvent, openDialog, setDebugGate, tabState } from "./cdp.js";
import { waitForDownload } from "./downloads.js";
import { PAUSED_ERROR, isPaused } from "./pause.js";
import { agentTabs, createAgentTab, createAgentTabs, endSession, markTab, noteAgentInput, onTabOpened, openingSession, setLiveSessions } from "./sessions.js";
import { checkRequest } from "./guard.js";
import { fromExtensionPage, isRecord } from "./sender.js";
import { LOAD_PAGE_HINT, PAIRING_HOST, MANAGEMENT_METHODS, actsOn, extensionBuild, ignore, isPressInput, logFailure, methodRules } from "./shared.js";

/** @typedef {import("./shared.js").Method} Method */
/** @template {Method} M @typedef {import("./shared.js").Params<M>} Params */
/** @template {Method} M @typedef {import("./shared.js").Result<M>} Result */
/** @typedef {import("./shared.js").TabInfo} TabInfo */
// The agent session the hub says a request comes from; null for a request without one.
/** @typedef {string | null} Session */

// The message of an error or rejection reason of any kind.
/** @param {unknown} error */
function errorText(error) {
  const message = isRecord(error) ? error.message : undefined;
  return typeof message === "string" ? message : String(error);
}

// Content scripts that this extension runs in pages (see cdp.js) get no access to its storage, which
// holds the access setting, the shares and the hub secret. Session storage starts out this way. Agent
// requests wait for the restriction, and fail while it has not taken effect (see handle).
const storageRestriction = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]).then(
  () => null,
  (error) =>
    `${chrome.runtime.getManifest().name} could not keep web pages' content scripts out of its storage (${errorText(error)}), so it runs no agent requests. Ask the user to update the browser and reload the extension.`,
);

const OFFSCREEN_ALARM = "offscreen-check";
const LOAD_TIMEOUT_MS = 20_000;
// CDP events the MCP server reacts to; the rest stay inside the extension.
const FORWARDED_EVENTS = new Set(["Page.javascriptDialogOpening", "Page.javascriptDialogClosed", "Page.fileChooserOpened", "Page.windowOpen"]);

/** @param {chrome.tabs.Tab} tab @returns {TabInfo} */
function tabInfo(tab) {
  return {
    id: idOf(tab),
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

// The ID of a tab the tabs or windows API returned. The browser leaves it out only for tabs that are not
// in a window (such as those of the sessions API), which these calls do not return.
/** @param {chrome.tabs.Tab} tab */
function idOf(tab) {
  if (tab.id === undefined) throw new Error("The browser returned a tab without an ID");
  return tab.id;
}

// History and bookmarks are optional permissions that the user turns on in the popup.
/** @param {"history" | "bookmarks"} permission @param {string} what */
async function requirePermission(permission, what) {
  if (await chrome.permissions.contains({ permissions: [permission] })) return;
  const name = chrome.runtime.getManifest().name;
  throw new Error(`The user has not given ${name} access to ${what}. Tell the user; they can turn it on in the ${name} popup in the browser toolbar.`);
}

// Resolves with whether the tab finished loading; slow pages are returned as they are after the timeout.
// A page that opens a JavaScript dialog loads nothing until the dialog is answered (a page asking whether
// to leave holds the navigation back), so the wait ends there. It also ends when the tab closes (as one
// whose address turns out to be a download does) or its page crashes.
/** @param {number} tabId @param {number} [timeoutMs] @returns {Promise<boolean>} */
function waitForLoad(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    /** @param {boolean} loaded */
    const done = (loaded) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      stopCdpWatch();
      resolve(loaded);
    };
    const stopCdpWatch = onCdpEvent((id, method, _params, source) => {
      if (id === tabId && (method === "Page.javascriptDialogOpening" || (method === "Inspector.targetCrashed" && !source))) done(false);
    });
    /** @param {number} id @param {chrome.tabs.OnUpdatedInfo} change */
    const listener = (id, change) => {
      if (id === tabId && change.status === "complete") done(true);
    };
    /** @param {number} id */
    const onRemoved = (id) => id === tabId && done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(onRemoved);
    if (openDialog(tabId)) return done(false);
    chrome.tabs.get(tabId).then((tab) => tab.status === "complete" && done(true), () => done(false));
  });
}

// Attaches the debugger before a navigation the browser itself performs. A page may ask whether to leave
// (beforeunload, after input); only an attached debugger learns of that dialog and can answer it, and
// without one the tab stays on a page that answers nothing. A tab the debugger cannot attach to
// navigates as it is.
/** @param {number} tabId @param {Session} session */
function attachBeforeLeaving(tabId, session) {
  return cdp(tabId, "Page.enable", {}, undefined, undefined, { session }).catch(ignore("a tab the debugger cannot attach to navigates as it is"));
}

const DOWNLOAD_HINT = 'The file is in the browser\'s downloads folder. To learn the path of such a download, call tab.playwright.waitForEvent("download") in a tab with a page before the tab.goto(url) that starts it (the goto fails with this message), then read the download\'s path().';

// Opens a tab without taking the user's focus: in the window the user used last or, when the browser has
// no normal window (none at all, or only popup and app windows), in a new window that opens unfocused.
/** @param {string} url @returns {Promise<chrome.tabs.Tab>} */
async function openBackgroundTab(url) {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (window) return chrome.tabs.create({ url, windowId: window.id, active: false });
  const created = await chrome.windows.create({ url, focused: false });
  const tab = created?.tabs?.[0];
  if (!tab) throw new Error("The browser opened a window for the tab without a tab in it");
  return tab;
}

/** @param {string} url */
const withoutFragment = (url) => url.split("#")[0];

// Chromium ends the whole browser (a failed check, seen in version 156) when the debugger navigates a tab
// that never left the blank page it started with to another fragment of that page, such as
// about:blank#top. Whether a blank page is that first one cannot be read, so every navigation between
// fragments of a blank page goes through the page itself, which is the same navigation and safe.
// It runs as the user's own navigation would (with user activation), so that it gets a history entry
// that tab.back() returns to. Resolves with what Page.navigate replies for a navigation within a
// document, or with null when `params` name another kind of navigation, which the debugger performs.
/**
 * @param {number} tabId
 * @param {{ url?: unknown, frameId?: unknown } | undefined} params Of Page.navigate, as the agent sent them.
 * @param {Session} session
 * @returns {Promise<{ frameId: string } | null>}
 */
async function navigateWithinBlankPage(tabId, params, session) {
  // As the browser reads the address: with the scheme in lower case and without surrounding spaces.
  const given = String(params?.url ?? "");
  const url = URL.canParse(given) ? new URL(given).href : "";
  if (!url.startsWith("about:blank") || !url.includes("#")) return null;
  const tab = await chrome.tabs.get(tabId);
  if (withoutFragment(tab.url || "about:blank") !== withoutFragment(url)) return null;
  const caller = { session };
  const { frameTree } = await cdp(tabId, "Page.getFrameTree", {}, undefined, undefined, caller);
  if (params?.frameId !== undefined && params.frameId !== frameTree.frame.id) return null;
  const { exceptionDetails } = await cdp(tabId, "Runtime.evaluate", { expression: `location.href = ${JSON.stringify(url)}`, returnByValue: true, userGesture: true }, undefined, undefined, caller);
  if (exceptionDetails) throw new Error(`Navigation to ${url} failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
  return { frameId: frameTree.frame.id };
}

// From User-Agent Client Hints, which Chromium browsers have and the DOM types leave out.
function browserName() {
  const data = "userAgentData" in navigator && isRecord(navigator.userAgentData) ? navigator.userAgentData : {};
  /** @type {unknown[]} */
  const entries = Array.isArray(data.brands) ? data.brands : [];
  const brands = entries.map((entry) => (isRecord(entry) ? entry.brand : undefined)).filter((brand) => typeof brand === "string");
  return brands.find((brand) => !/Chromium|Not.?A.?Brand/i.test(brand)) ?? "Chromium";
}

// The fingerprint of the code this extension runs (see shared.js), computed once per worker start.
const build = extensionBuild((file) => fetch(chrome.runtime.getURL(file)).then((response) => response.text())).catch(() => ({ hash: null }));

// Raw DevTools commands that end a tab's page, which only a tab's owner may do (see requireOwnTab).
const TAB_ENDING_CDP = new Set(["Page.close", "Page.crash"]);

// Each handler gets the request's parameters and `session`, the agent session the hub says the request
// comes from. Tab methods check access first (see access.js). There is one for each method of the
// protocol (shared.js), and each takes and returns what the protocol gives for its method.
/** @type {{ [M in Method]: (params: Params<M>, session: Session) => Result<M> | Promise<Result<M>> }} */
const handlers = {
  "browser.info": async (_, session) => {
    const mode = await accessMode();
    const { hidden } = await visibleTabs(session, await chrome.tabs.query({}));
    const problem = await storageRestriction;
    return {
      name: browserName(),
      userAgent: navigator.userAgent,
      version: chrome.runtime.getManifest().version,
      build: (await build).hash,
      id: chrome.runtime.id,
      paused: await isPaused(),
      access: { mode, hiddenTabs: hidden },
      ...(problem ? { problem } : {}),
    };
  },

  "tabs.list": async (_, session) => (await visibleTabs(session, await chrome.tabs.query({}))).shown.map(tabInfo),

  "tabs.get": async ({ tabId }) => tabInfo(await chrome.tabs.get(tabId)),

  // The active tab of the window the user used last, when the session may use it.
  "tabs.selected": async (_, session) => {
    const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
    const [tab] = window ? await chrome.tabs.query({ windowId: window.id, active: true }) : [];
    return tab?.id !== undefined && (await mayAccess(session, tab.id)) ? tabInfo(tab) : null;
  },

  "tabs.create": async ({ url }, session) => {
    const tabId = idOf(await createAgentTab(session, () => openBackgroundTab(url ?? "about:blank")));
    if (url) await waitForLoad(tabId);
    const opened = await chrome.tabs.get(tabId).catch(() => null);
    // The browser closes a new tab whose address turns out to be a file to download.
    if (!opened) throw new Error(`The tab opened for ${url} closed right away, as the browser does when an address is a file, which it downloads instead of showing. ${DOWNLOAD_HINT}`);
    return tabInfo(opened);
  },

  // CDP navigation reports blocked or failed loads instead of silently keeping the old page. The
  // browser lets an extension open a data: address only in a new tab: it aborts the navigation of an
  // existing one, also through the tabs API.
  // A tab without a page (its renderer crashed) takes no debugger command; the browser loads the address.
  "tabs.navigate": async ({ tabId, url }, session) => {
    if (await hasNoPage(tabId)) await chrome.tabs.update(tabId, { url });
    else if (!(await navigateWithinBlankPage(tabId, { url }, session))) {
      const { errorText, isDownload } = await cdp(tabId, "Page.navigate", { url }, undefined, undefined, { session });
      if (isDownload) throw new Error(`${url} is a file, which the browser downloaded instead of showing, so the tab keeps its page. ${DOWNLOAD_HINT}`);
      if (errorText && /^data:/i.test(url)) throw new Error(`Navigation to a data: address failed (${errorText}): the browser opens such an address only in a new tab. Use cua.createBrowserTab("1", url) instead.`);
      if (errorText) throw new Error(`Navigation to ${url} failed: ${errorText}`);
    }
    await waitForLoad(tabId);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  "tabs.history": async ({ tabId, direction }, session) => {
    await attachBeforeLeaving(tabId, session);
    if (direction === "back") await chrome.tabs.goBack(tabId);
    else if (direction === "forward") await chrome.tabs.goForward(tabId);
    else await chrome.tabs.reload(tabId);
    await waitForLoad(tabId);
    return tabInfo(await chrome.tabs.get(tabId));
  },

  "tabs.waitForLoad": async ({ tabId, timeoutMs }) => ({ loaded: await waitForLoad(tabId, timeoutMs) }),

  "tabs.close": async ({ tabId }, session) => {
    await requireOwnTab(session, tabId);
    await closeTab(tabId);
    return null;
  },

  "tabs.mark": ({ tabId, mark }) => markTab(tabId, mark),
  // The session's own tabs and their marks.
  "tabs.agent": async (_, session) => Object.fromEntries(Object.entries(await agentTabs()).filter(([, entry]) => entry.sessionId === session)),
  "session.end": (_, session) => endSession(session),

  cdp: async ({ tabId, method, params, sessionId, timeoutMs }, session) => {
    if (params !== undefined && !isRecord(params)) throw new Error(`${method} takes its parameters as an object`);
    if (TAB_ENDING_CDP.has(method)) await requireOwnTab(session, tabId);
    if (isPressInput(method, params)) noteAgentInput(tabId, session);
    if (method === "Page.navigate" && !sessionId) {
      const withinBlankPage = await navigateWithinBlankPage(tabId, params, session);
      if (withinBlankPage) return withinBlankPage;
    }
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
    if (!(isManagementNamespace(namespace) && MANAGEMENT_METHODS[namespace].includes(method))) throw new Error(`${namespace}.${method} is not available`);
    if (namespace === "bookmarks") await requirePermission("bookmarks", "the bookmarks");
    checkManagementArguments(namespace, method, args);
    const call = await withDefaults(namespace, method, args);
    await checkManagementAccess(session, namespace, method, call);
    const own = OPENING_METHODS[`${namespace}.${method}`] ?? CLOSING_METHODS[`${namespace}.${method}`] ?? LEAVING_METHODS[`${namespace}.${method}`];
    return withoutHiddenTabs(session, namespace, await (own ? own(session, call) : managementCall(namespace, method)(...call)));
  },

  // Picks up edited extension files without visiting the extensions page.
  "extension.reload": () => {
    setTimeout(() => chrome.runtime.reload(), 100);
    return null;
  },
};

// For a method that needs the tab's loaded page (see PROTOCOL in shared.js). Checked after access, so
// that only a tab the session may use is reported as discarded.
const DISCARDED = `The browser discarded this tab to free memory, so its page and anything typed into it are gone. ${LOAD_PAGE_HINT}`;

// Management tab methods and how their first argument names tabs. Chrome lets several of them leave the
// tab out and act on the selected tab instead; agents must name it, so every target is checked.
/** @type {Partial<Record<string, "id" | "ids" | "options">>} */
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

/** @typedef {keyof typeof MANAGEMENT_METHODS} ManagementNamespace */

/** @param {string} namespace @returns {namespace is ManagementNamespace} */
function isManagementNamespace(namespace) {
  return Object.hasOwn(MANAGEMENT_METHODS, namespace);
}

// A method of MANAGEMENT_METHODS, bound to its namespace. It takes the arguments the agent passed, which
// the browser checks against the method's signature, and resolves with what the method resolves with.
/** @param {ManagementNamespace} namespace @param {string} method @returns {(...args: unknown[]) => Promise<unknown>} */
function managementCall(namespace, method) {
  const api = chrome[namespace];
  /** @type {unknown} */
  const call = Reflect.get(api, method);
  if (!MANAGEMENT_METHODS[namespace].includes(method) || typeof call !== "function") throw new Error(`${namespace}.${method} is not available`);
  return async (...args) => Reflect.apply(call, api, args);
}

/** @param {unknown} value @returns {value is number} */
function isTabId(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// A tab group ID that management arguments name, which the access checks read before the browser
// checks the call.
/** @param {unknown} value */
function groupIdOf(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Name the tab group by its ID, not ${JSON.stringify(value)}`);
  return value;
}

// The tabs a management call acts on, from arguments that name them explicitly.
/** @param {string} method @param {unknown[]} args @returns {number[]} */
function tabIdsOf(method, args) {
  const [first] = args;
  /** @type {unknown[]} */
  const ids = TAB_ARGUMENTS[method] === "id" ? [first] : TAB_ARGUMENTS[method] === "ids" ? [first].flat() : [isRecord(first) ? first.tabIds : undefined].flat();
  if (!ids.length || !ids.every(isTabId)) throw new Error(`management.tabs.${method} needs the ID${TAB_ARGUMENTS[method] === "id" ? "" : "s"} of the tab${TAB_ARGUMENTS[method] === "id" ? "" : "s"} it acts on`);
  return ids;
}

// Checks that hold in every access mode: tab methods name their tabs, and organizing tabs never
// navigates them (pages are opened and driven through tab objects).
/** @param {ManagementNamespace} namespace @param {string} method @param {unknown[]} args */
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
// checkManagementArguments has checked that windows.create takes an object or nothing and that
// tabs.group takes an object (whose tabIds tabIdsOf reads).
/** @param {ManagementNamespace} namespace @param {string} method @param {unknown[]} args @returns {Promise<unknown[]>} */
async function withDefaults(namespace, method, args) {
  const [first, ...rest] = args;
  const options = isRecord(first) ? first : undefined;
  if (namespace === "windows" && method === "create" && options?.state !== "maximized" && options?.state !== "fullscreen") return [{ focused: false, ...options }, ...rest];
  // Spread as the browser would read them: no createProperties (undefined or null) adds nothing.
  const createProperties = options?.createProperties ?? {};
  if (namespace === "tabs" && method === "group" && options && options.groupId === undefined && isRecord(createProperties) && createProperties.windowId === undefined) {
    const { windowId } = await chrome.tabs.get(tabIdsOf(method, args)[0]);
    return [{ ...options, createProperties: { ...createProperties, windowId } }, ...rest];
  }
  return args;
}

// Management calls may act only on tabs and groups whose tabs the session may reach, and change, switch
// tabs in or move tabs into only the session's own windows (see access.js).
/** @param {Session} session @param {ManagementNamespace} namespace @param {string} method @param {unknown[]} args */
async function checkManagementAccess(session, namespace, method, args) {
  if ((await accessMode()) === ALL_TABS) return;
  /** @param {number[]} tabs */
  const requireTabs = async (tabs) => {
    for (const tabId of tabs) await requireAccess(session, tabId);
  };
  /** @param {number[]} tabs */
  const requireOwnTabs = async (tabs) => {
    for (const tabId of tabs) await requireOwnTab(session, tabId);
  };
  /** @param {unknown} groupId */
  const groupTabs = async (groupId) => (await chrome.tabs.query({ groupId: groupIdOf(groupId) })).map(idOf);
  // Tabs that leave their window for `windowId` move into it, which must be the session's.
  /** @param {number[]} tabIds @param {unknown} windowId */
  const requireMoveInto = async (tabIds, windowId) => {
    const tabs = await Promise.all(tabIds.map((tabId) => chrome.tabs.get(tabId)));
    if (tabs.some((tab) => tab.windowId !== windowId)) await requireOwnWindow(session, windowId);
  };
  const [first, second] = args;
  const options = isRecord(first) ? first : undefined;
  const changes = isRecord(second) ? second : undefined;
  if (namespace === "tabs" && TAB_ARGUMENTS[method]) await requireTabs(tabIdsOf(method, args));
  if (namespace === "tabs" && (["move", "group", "ungroup", "remove", "discard"].includes(method) || (method === "update" && changes?.pinned !== undefined))) await requireOwnTabs(tabIdsOf(method, args));
  // Activating or highlighting a tab switches what the user sees in its window, and so can unhighlighting
  // the active tab, which activates another highlighted one.
  if (namespace === "tabs" && method === "update" && ["active", "highlighted", "selected"].some((key) => changes?.[key] !== undefined)) await requireOwnWindow(session, (await chrome.tabs.get(tabIdsOf(method, args)[0])).windowId);
  if (namespace === "tabs" && method === "move" && changes?.windowId !== undefined) await requireMoveInto(tabIdsOf(method, args), changes.windowId);
  if (namespace === "tabs" && method === "group") {
    if (options?.groupId !== undefined) {
      // Joining a group changes it, so the session must reach every tab in it.
      await requireOwnTabs(await groupTabs(options.groupId));
      await requireMoveInto(tabIdsOf(method, args), (await chrome.tabGroups.get(groupIdOf(options.groupId))).windowId);
    } else {
      await requireMoveInto(tabIdsOf(method, args), isRecord(options?.createProperties) ? options.createProperties.windowId : undefined);
    }
  }
  // A new window may take an existing tab, which moves it.
  if (namespace === "windows" && method === "create" && options?.tabId !== undefined) {
    if (!isTabId(options.tabId)) throw new Error(`management.windows.create takes the ID of the tab it moves, not ${JSON.stringify(options.tabId)}`);
    await requireOwnTabs([options.tabId]);
  }
  if (namespace === "windows" && (method === "update" || method === "remove")) await requireOwnWindow(session, first);
  if (namespace === "tabGroups" && (method === "update" || method === "move")) await requireOwnTabs(await groupTabs(first));
  if (namespace === "tabGroups" && method === "move" && changes?.windowId !== undefined && changes.windowId !== (await chrome.tabGroups.get(groupIdOf(first))).windowId) {
    await requireOwnWindow(session, changes.windowId);
  }
}

// A management call that this module carries out itself instead of the browser method of its name. The
// arguments are those checkManagementArguments, withDefaults and checkManagementAccess have passed.
/** @typedef {(session: Session, args: unknown[]) => Promise<unknown>} OwnManagementCall */

// Management calls that close tabs close each one with closeTab, so that a page asking whether to leave
// does not keep its tab open.
/** @type {Partial<Record<string, OwnManagementCall>>} */
const CLOSING_METHODS = {
  "tabs.remove": async (_session, args) => {
    await Promise.all(tabIdsOf("remove", args).map((tabId) => closeTab(tabId)));
  },
  // A window goes with its last tab.
  "windows.remove": async (_session, [windowId]) => {
    if (typeof windowId !== "number") throw new Error(`Name the window by its ID, not ${JSON.stringify(windowId)}`);
    const tabs = await chrome.tabs.query({ windowId });
    if (!tabs.length) return chrome.windows.remove(windowId);
    await Promise.all(tabs.map((tab) => closeTab(idOf(tab))));
  },
};

// Management calls that make a tab leave its page.
/** @type {Partial<Record<string, OwnManagementCall>>} */
const LEAVING_METHODS = {
  "tabs.reload": async (session, args) => {
    await attachBeforeLeaving(tabIdsOf("reload", args)[0], session);
    return managementCall("tabs", "reload")(...args);
  },
};

// Management calls that open tabs. Like tabs.create, in every access mode, they open the tabs for the
// session: its own, in the agent group, closed when it ends.
/** @type {Partial<Record<string, OwnManagementCall>>} */
const OPENING_METHODS = {
  // The duplicate is the session's; the original keeps its owner or share. The browser activates a
  // duplicate, so the tab that was active in its window becomes active again, unless the user has
  // switched tabs since.
  "tabs.duplicate": async (session, args) => {
    const [tabId] = tabIdsOf("duplicate", args);
    const { windowId } = await chrome.tabs.get(tabId);
    const [active] = await chrome.tabs.query({ windowId, active: true });
    const [duplicate] = await createAgentTabs(session, async () => {
      const tab = await chrome.tabs.duplicate(tabId);
      if (!tab) throw new Error(`The browser did not duplicate tab ${tabId}`);
      return [tab];
    });
    const duplicateId = idOf(duplicate);
    const stillActive = (await chrome.tabs.get(duplicateId).catch(() => null))?.active;
    if (active?.id !== undefined && active.id !== duplicateId && stillActive) await chrome.tabs.update(active.id, { active: true }).catch(ignore("the tab that was active may have closed meanwhile"));
    return chrome.tabs.get(duplicateId);
  },
  // A tab moved into the new window with `tabId` keeps its owner or share; the others are new.
  "windows.create": async (session, [options]) => {
    /** @type {{ windowId?: number }} */
    const created = {};
    await createAgentTabs(session, async () => {
      // windows.create resolves with the window it opened.
      const window = /** @type {chrome.windows.Window | undefined} */ (await managementCall("windows", "create")(options));
      if (window?.id === undefined) throw new Error("The browser opened no window");
      created.windowId = window.id;
      return (await chrome.tabs.query({ windowId: window.id })).filter((tab) => tab.id !== (isRecord(options) ? options.tabId : undefined));
    });
    if (created.windowId === undefined) throw new Error("The browser opened no window");
    return chrome.windows.get(created.windowId, { populate: true });
  },
};

// Tabs the session may not reach are left out of management results, and so are windows and groups
// without any tab it may reach. `result` is what a method of `namespace` resolved with.
/** @param {Session} session @param {ManagementNamespace} namespace @param {unknown} result */
async function withoutHiddenTabs(session, namespace, result) {
  if ((await accessMode()) === ALL_TABS) return result;
  /** @param {chrome.tabs.Tab[]} tabs */
  const filterTabs = async (tabs) => (await visibleTabs(session, tabs)).shown;
  if (namespace === "tabs") {
    // The tabs methods resolve with a tab, a list of tabs, a group ID (group) or nothing.
    const tabs = /** @type {chrome.tabs.Tab | chrome.tabs.Tab[] | number | undefined} */ (result);
    if (Array.isArray(tabs)) return filterTabs(tabs);
    if (tabs && typeof tabs === "object" && isTabId(tabs.id) && !(await filterTabs([tabs])).length) {
      throw new Error("This tab is not one of this session's tabs, and the user has not shared it");
    }
  }
  if (namespace === "windows" && result && typeof result === "object") {
    // The windows methods resolve with a window or a list of windows (remove with nothing).
    const windows = /** @type {chrome.windows.Window | chrome.windows.Window[]} */ (result);
    /** @param {chrome.windows.Window} window */
    const filterWindow = async (window) => (Array.isArray(window.tabs) ? { ...window, tabs: await filterTabs(window.tabs) } : window);
    // A window without an ID (the browser gives every window one) counts as one the session does not see.
    /** @param {chrome.windows.Window} window */
    const sees = async (window) => window.id !== undefined && (await seesWindow(session, window.id));
    if (Array.isArray(windows)) {
      const shown = [];
      for (const window of windows) if (await sees(window)) shown.push(await filterWindow(window));
      return shown;
    }
    if (!(await sees(windows))) throw new Error("This window holds no tab of this session or shared by the user");
    return filterWindow(windows);
  }
  if (namespace === "tabGroups") {
    // The tabGroups methods resolve with a group, a list of groups or nothing (move without a window).
    const groups = /** @type {chrome.tabGroups.TabGroup | chrome.tabGroups.TabGroup[] | undefined} */ (result);
    /** @param {chrome.tabGroups.TabGroup} group */
    const visible = async (group) => (await filterTabs(await chrome.tabs.query({ groupId: group.id }))).length > 0;
    if (Array.isArray(groups)) {
      const shown = [];
      for (const group of groups) if (await visible(group)) shown.push(group);
      return shown;
    }
    if (groups && !(await visible(groups))) throw new Error("This tab group holds no tab of this session or shared by the user");
  }
  return result;
}

// The debugger acts for an agent's request only while that request's session may use the tab, and for the
// extension's own work (downloads) only while some session may.
setDebugGate((tabId, caller) => (caller === EXTENSION_WORK ? anyoneMayAccess(tabId) : mayAccess("session" in caller ? caller.session : null, tabId)));

// A tab no session may reach keeps no debugger attached: after the user stops sharing it, switches to
// "agent tabs" or a session ends, it is detached at once.
async function detachUnreachable() {
  for (const tabId of attachedTabIds()) if (!(await anyoneMayAccess(tabId))) await detach(tabId);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if ((area === "session" && "sharedTabs" in changes) || (area === "local" && "accessMode" in changes)) detachUnreachable().catch(logFailure("Detaching the debugger from tabs no session may use"));
});
// A share ends with its tab.
chrome.tabs.onRemoved.addListener((tabId) => {
  endShareOfClosedTab(tabId).catch(logFailure("Ending the share of a closed tab"));
});

// A hub of a version before tab ownership sends requests without the session they come from.
// A hub client that did not name its session (no hello) acts for no session. Tabs that no session owns,
// such as the ones the user shares, would count as its own, so it may use none.
const NO_SESSION = "This request names no agent session: the MCP server that relays it did not say which session it comes from, so it may use no tab.";
const OUTDATED_HUB = `The ${chrome.runtime.getManifest().name} MCP server that relays this request is older than the browser extension and does not say which agent session it comes from. Ask the user to run \`bruse setup\` and start new agent sessions.`;

// Native messaging supplies the secret locally. Only HMAC proofs cross the hub port.
/**
 * The hub behind one connection of the offscreen document (its generation `gen`) and how far its
 * authentication got: whether it was challenged, the proof it must send back and whether it did.
 * @typedef {object} HubConnection
 * @property {number} gen
 * @property {boolean} verified
 * @property {boolean} challenged
 * @property {string | null} expectedHubMac
 */
/** @param {number} gen @returns {HubConnection} */
const unverifiedHub = (gen) => ({ gen, verified: false, challenged: false, expectedHubMac: null });
let hub = unverifiedHub(0);

// A new connection, or none: its hub has yet to authenticate and to report the live sessions.
/** @param {number} gen */
function resetHub(gen) {
  hub = unverifiedHub(gen);
  setLiveSessions(null);
}

/** @param {ArrayBuffer | Uint8Array} bytes */
function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(length = 32) {
  return hex(crypto.getRandomValues(new Uint8Array(length)));
}

/** @param {string} secret @param {string} message */
async function hmac(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// The code in PAIRING_FAILURES for an error of the native host call. Chrome for Testing 156 words them
// "Specified native messaging host not found.", "Access to the specified native messaging host is
// forbidden." (allowed_origins without this extension), "Native host has exited." and "Error when
// communicating with the native messaging host." (output that is not a native message).
/** @param {unknown} error @returns {keyof typeof import("./shared.js").PAIRING_FAILURES} */
function pairingFailure(error) {
  const message = errorText(error);
  if (/not found/i.test(message)) return "host-missing";
  if (/forbidden/i.test(message)) return "host-forbidden";
  return "host-failed";
}

// The answer to a hub's challenge: proof of the pairing secret, or why the extension has none.
/** @param {string} nonce @param {HubConnection} connection */
async function answerChallenge(nonce, connection) {
  // Always consult the host: a reinstall or a restored browser profile may retain a stale secret.
  // An existing pairing can still connect before setup installs the host during an upgrade.
  const stored = (await chrome.storage.local.get("hubSecret")).hubSecret;
  let hubSecret = typeof stored === "string" ? stored : undefined;
  try {
    /** @type {unknown} */
    const response = await chrome.runtime.sendNativeMessage(PAIRING_HOST, { type: "secret" });
    const secret = isRecord(response) ? response.secret : undefined;
    if (typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("Invalid native pairing response");
    hubSecret = secret;
    await chrome.storage.local.set({ hubSecret });
    await chrome.storage.local.remove("pendingHubSecret");
  } catch (error) {
    if (!hubSecret) {
      console.warn(`Native pairing unavailable: ${errorText(error)}`);
      return { type: "pairing-failed", reason: pairingFailure(error) };
    }
  }
  const ownNonce = randomHex();
  connection.expectedHubMac = await hmac(hubSecret, `hub:${ownNonce}`);
  return { type: "auth", mac: await hmac(hubSecret, `extension:${nonce}`), nonce: ownNonce };
}

let reconnectRequestedFor = 0;
/** @param {number} gen */
function requestReconnect(gen) {
  if (reconnectRequestedFor === gen) return;
  reconnectRequestedFor = gen;
  chrome.runtime.sendMessage({ target: "offscreen", type: "reconnect", gen }).catch(ignore("without an offscreen document there is no connection to reconnect"));
}

// Sends a message to the authenticated hub through the offscreen document.
/** @param {Record<string, unknown>} message */
function send(message) {
  if (!hub.verified) return;
  chrome.runtime.sendMessage({ target: "offscreen", type: "send", gen: hub.gen, data: JSON.stringify(message) }).catch(ignore("without an offscreen document there is no hub connection to send to"));
}

/** @param {unknown} value @returns {value is Method} */
const isMethod = (value) => methodRules(value) !== undefined;

// Runs the handler of `method`; the types tie the parameters and the result to the method.
/**
 * @template {Method} M
 * @param {M} method
 * @param {Params<M>} params
 * @param {Session} session
 * @returns {Promise<Result<M>>}
 */
async function run(method, params, session) {
  return handlers[method](params, session);
}

// Handles one message of the hub connection of generation `gen`, resolving with the reply to send, if any.
/** @param {number} gen @param {unknown} text @returns {Promise<string | null>} */
async function handle(gen, text) {
  if (typeof text !== "string") return null;
  /** @type {unknown} */
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;
  if (gen !== hub.gen) resetHub(gen);
  if (message.type === "challenge") {
    // Each answer starts the native host, so whatever holds the port gets one per connection.
    if (hub.challenged) return null;
    hub.challenged = true;
    // A hub's nonce is 32 random bytes; whatever sends another holds the port without being a hub.
    const nonce = String(message.nonce);
    if (!/^[0-9a-f]{64}$/.test(nonce)) return null;
    const connection = hub;
    const reply = await answerChallenge(nonce, connection);
    return hub === connection ? JSON.stringify(reply) : null;
  }
  if (message.type === "auth-ok") {
    hub.verified = Boolean(hub.expectedHubMac) && message.mac === hub.expectedHubMac;
    return null;
  }
  const { id, method } = message;
  // A restarted service worker has lost the authentication of an open connection; reconnecting makes
  // the hub authenticate again.
  if (!hub.verified) requestReconnect(gen);
  if (message.type === "live-sessions") {
    if (hub.verified && Array.isArray(message.sessionIds)) setLiveSessions(message.sessionIds.filter((sessionId) => typeof sessionId === "string"));
    return null;
  }
  if (id === undefined) return null; // keepalive
  if (!hub.verified) return JSON.stringify({ id, error: "The browser connection is being authenticated again; retry the call" });
  const rules = methodRules(method);
  const storageProblem = await storageRestriction;
  if (storageProblem && !rules?.sessionless) return JSON.stringify({ id, error: storageProblem });
  try {
    if (!rules || !isMethod(method)) throw new Error(`Unknown method ${String(method)}`);
    // The hub sends a string or null (browser-link.mjs); a hub too old to send any sends no session.
    const session = typeof message.session === "string" ? message.session : null;
    const params = message.params ?? {};
    if (!isRecord(params)) throw new Error(`The parameters of ${method} are not an object`);
    if (!rules.pauseExempt && (await isPaused())) throw new Error(PAUSED_ERROR);
    if (!rules.sessionless && !("session" in message)) throw new Error(OUTDATED_HUB);
    if (!rules.sessionless && session === null) throw new Error(NO_SESSION);
    // Access comes first, so a request for a hidden tab learns nothing about the tab's page.
    /** @type {number | undefined} */
    let tabId;
    if (actsOn(method, "tab")) {
      if (typeof params.tabId !== "number") throw new Error(`${method} needs the ID of a tab, not ${String(JSON.stringify(params.tabId))}`);
      tabId = params.tabId;
      await requireAccess(session, tabId);
    }
    await checkRequest(method, params);
    if (tabId !== undefined && actsOn(method, "loaded-page") && (await chrome.tabs.get(tabId).catch(() => null))?.discarded) throw new Error(DISCARDED);
    // The authenticated hub sends each method the parameters PROTOCOL gives it (browser-link.mjs);
    // guard.js and the checks above read the fields they depend on as unknown.
    return JSON.stringify({ id, result: (await run(method, /** @type {Params<Method>} */ (params), session)) ?? null });
  } catch (error) {
    return JSON.stringify({ id, error: errorText(error) });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isRecord(message) || message.target !== "worker" || !fromExtensionPage(sender)) return false;
  const { type, gen } = message;
  if (typeof gen !== "number") return false;
  if (type === "hub-open" || type === "hub-closed") {
    if (gen >= hub.gen) resetHub(gen);
    return false;
  }
  if (type !== "hub-message") return false;
  handle(gen, message.data).then(sendResponse, (error) => {
    // The hub gets no answer and drops the connection after its authentication deadline.
    console.error("Hub message failed:", error);
    sendResponse(null);
  });
  return true;
});

// Events go only to the sessions that may use their tab now (`audience`, null for all); the hub routes
// them. An event no session may see is not sent. Working out the audience takes storage reads, so events
// pass through one queue and keep their order.
/** @type {Promise<void>} */
let eventQueue = Promise.resolve();
/** @param {Record<string, unknown>} event @param {() => Promise<string[] | null>} audience */
function sendEvent(event, audience) {
  eventQueue = eventQueue
    .then(async () => {
      const recipients = await audience();
      if (recipients === null || recipients.length) send({ ...event, type: "event", audience: recipients });
    })
    .catch(ignore("an event whose audience cannot be read goes to nobody, and the queue goes on"));
}

// A page's request to open a window names the address of the tab it opens, which belongs to whoever
// caused the opening: from a shared tab it goes only to the session whose input caused it (fixed now,
// as sessions.js does for ownership), and to nobody when that is not one session.
/** @param {number} tabId @param {string | null} initiator @returns {Promise<string[] | null>} */
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
      if (!/single offscreen/i.test(errorText(error))) throw error;
    });
}

function keepOffscreenDocument() {
  ensureOffscreenDocument().catch(logFailure("Creating the offscreen document"));
}

// Debugger sessions this extension still holds from before a service worker restart have lost their
// tracked state (and would never be detached when idle); start them over.
chrome.debugger
  .getTargets()
  .then((targets) => {
    for (const target of targets) if (target.attached && target.tabId !== undefined) chrome.debugger.detach({ tabId: target.tabId }).catch(ignore("the tab may have closed or been detached meanwhile"));
  })
  .catch(logFailure("Detaching debugger sessions from before the restart"));

// The offscreen document reconnects on its own; this only recreates it if the browser closed it.
chrome.alarms.create(OFFSCREEN_ALARM, { periodInMinutes: 0.5 }).catch(logFailure("Scheduling the offscreen document check"));
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === OFFSCREEN_ALARM) keepOffscreenDocument();
});
chrome.runtime.onStartup.addListener(keepOffscreenDocument);
chrome.runtime.onInstalled.addListener(keepOffscreenDocument);
keepOffscreenDocument();
