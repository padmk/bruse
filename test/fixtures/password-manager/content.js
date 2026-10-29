// Like 1Password's inline menu: a wrapper element with a closed shadow root that holds the extension's
// frame and puts the frame back when only the frame is removed. It goes into the page's shadow root
// (#shadow-host) when there is one. The menu shows at load with #menu in the URL, or when the page posts
// "show-menu". With #unknown-menu the wrapper is an element no password manager uses, so it stays.

function showMenu(name = "com-1password-menu") {
  const wrapper = document.createElement(name);
  const shadow = wrapper.attachShadow({ mode: "closed" });
  const addFrame = () => {
    const frame = document.createElement("iframe");
    frame.src = chrome.runtime.getURL("menu.html");
    shadow.append(frame);
  };
  addFrame();
  new MutationObserver(() => {
    if (wrapper.isConnected && !shadow.querySelector("iframe")) addFrame();
  }).observe(shadow, { childList: true });
  (document.querySelector("#shadow-host")?.shadowRoot ?? document.body).append(wrapper);
}

if (location.hash === "#menu") showMenu();
if (location.hash === "#unknown-menu") showMenu("unknown-menu");
window.addEventListener("message", (event) => event.data === "show-menu" && showMenu());
