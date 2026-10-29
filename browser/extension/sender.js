// Messages between the service worker and the offscreen document carry the hub's requests, so each side
// takes them only from the extension's own pages: never from a content script, which runs in web pages
// with this extension's runtime API, nor from another extension.

export function fromExtensionPage(sender) {
  return !sender.tab && sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
}
