// Splits a stream of newline-delimited JSON messages into lines. Only "\n" ends a message: JSON text may hold
// a raw U+2028 or U+2029 inside a string, which node:readline would take for a line end and split the message.
import { StringDecoder } from "node:string_decoder";

export function onLines(stream, onLine, onEnd = () => {}) {
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  const take = (text) => {
    buffered += text;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  };
  stream.on("data", (chunk) => take(typeof chunk === "string" ? chunk : decoder.write(chunk)));
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    take(decoder.end());
    if (buffered) onLine(buffered);
    buffered = "";
    onEnd();
  };
  // A stream that fails or closes without an end has ended as well: what came before it still counts.
  stream.on("end", end);
  stream.on("close", end);
  stream.on("error", end);
}
