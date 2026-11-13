// Messages between the service worker and the offscreen document carry the hub's requests, so each side
// takes them only from the extension's own pages: never from a content script, which runs in web pages
// with this extension's runtime API, nor from another extension. Their contents, like the hub's JSON,
// are read field by field with isRecord.

/** @param {chrome.runtime.MessageSender} sender */
export function fromExtensionPage(sender) {
  return !sender.tab && sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}

/**
 * Whether a value that arrived from outside (a runtime message, parsed JSON) is an object, whose fields
 * can then be read; each field is still unknown until checked.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null;
}
