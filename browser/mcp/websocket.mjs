// Minimal RFC 6455 WebSocket server side: handshake and text, ping, pong and close frames. Enough for
// the extension and peer MCP servers, which exchange small JSON messages.

import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function acceptUpgrade(request, socket) {
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new WebSocketPeer(socket);
}

export function rejectUpgrade(socket, status = "403 Forbidden") {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

class WebSocketPeer extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
  }

  send(text) {
    if (this.closed) return;
    this.writeFrame(0x1, Buffer.from(text, "utf8"));
  }

  close() {
    if (this.closed) return;
    this.writeFrame(0x8, Buffer.alloc(0));
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  writeFrame(opcode, payload) {
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) return this.close();
      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= this.buffer[maskOffset + (i % 4)];
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) return this.close();
      if (opcode === 0x9) this.writeFrame(0xa, payload);
      else if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (fin) {
          const message = Buffer.concat(this.fragments).toString("utf8");
          this.fragments = [];
          this.emit("message", message);
        }
      }
    }
  }
}
