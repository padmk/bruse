// Output of the running `js` call. The REPL installs a sink per call; API methods that display their
// result (getAXState, getScreenshot, getState, …) write through it.

let sink = null;

export function useOutput(next) {
  sink = next;
}

export function emitText(text) {
  sink?.text(String(text));
}

export function emitImage(bytes, mimeType = "image/png") {
  sink?.image(Buffer.from(bytes).toString("base64"), mimeType);
}
