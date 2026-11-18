// The tabs a chrome.windows.create call opened. The window it resolves with lists the tabs it has at that
// moment, and on macOS showing the window can run other events first, so a tab moved or opened into the
// window meanwhile is listed too. The call opens one tab per URL (one new tab page without a URL, none when
// it only moves `tabId`) at the start of the window; tabs that joined later come after them.

/**
 * @param {unknown} options what windows.create was called with
 * @param {chrome.tabs.Tab[] | undefined} tabs the tabs of the window it resolved with
 * @returns {chrome.tabs.Tab[]}
 */
export function tabsOpenedByWindowCreate(options, tabs) {
  const record = options !== null && typeof options === "object" ? /** @type {{ url?: unknown, tabId?: unknown }} */ (options) : {};
  const moved = record.tabId;
  const urls = Array.isArray(record.url) ? record.url.length : typeof record.url === "string" ? 1 : 0;
  const opened = urls || (moved === undefined ? 1 : 0);
  return [...(tabs ?? [])]
    .filter((tab) => tab.id !== moved)
    .sort((a, b) => a.index - b.index)
    .slice(0, opened);
}
