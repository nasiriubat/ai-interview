import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * A WebSocket server endpoint in about a hundred lines, so the fake needs no dependency.
 *
 * It does what the realtime transcription protocol needs and no more: the handshake, text frames
 * in both directions (client frames are masked, server frames are not), fragmentation, ping and
 * close. No extensions, no binary messages beyond passing the payload through.
 */
export interface Peer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
}

export interface PeerHandlers {
  onMessage(text: string): void;
  onClose(): void;
}

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  attach: (peer: Peer) => PeerHandlers,
): void {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let closed = false;
  const write = (opcode: number, payload: Buffer): void => {
    if (closed || socket.destroyed) return;
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | opcode, n])
        : n < 65_536
          ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff])
          : (() => {
              const b = Buffer.alloc(10);
              b[0] = 0x80 | opcode;
              b[1] = 127;
              b.writeBigUInt64BE(BigInt(n), 2);
              return b;
            })();
    socket.write(Buffer.concat([head, payload]));
  };
  const peer: Peer = {
    send: (text) => {
      write(0x1, Buffer.from(text, "utf8"));
    },
    close: (code = 1000, reason = "") => {
      if (closed) return;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      write(0x8, body);
      closed = true;
      socket.end();
    },
    get closed() {
      return closed;
    },
  };
  const handlers = attach(peer);
  let buffer: Buffer = Buffer.alloc(0);
  let fragments: Buffer[] = [];

  const finish = (): void => {
    if (!closed) {
      closed = true;
    }
    handlers.onClose();
  };

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0] ?? 0;
      const b1 = buffer[1] ?? 0;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + length) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
      const payload = Buffer.from(buffer.subarray(offset + maskLen, offset + maskLen + length));
      buffer = buffer.subarray(offset + maskLen + length);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i % 4] ?? 0);

      if (opcode === 0x8) {
        if (!closed) write(0x8, payload.subarray(0, 2));
        closed = true;
        socket.end();
        return;
      }
      if (opcode === 0x9) {
        write(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments).toString("utf8");
          fragments = [];
          handlers.onMessage(whole);
        }
      }
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
}
