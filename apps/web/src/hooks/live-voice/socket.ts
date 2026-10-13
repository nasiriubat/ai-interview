import { toServerFrame, type ClientFrame, type ServerFrame } from "@/lib/api/voice-live";
import { voiceSocketUrl } from "@/lib/env";

/** `WebSocket.OPEN`, spelled out so the hook does not depend on a global that tests replace. */
const SOCKET_OPEN = 1;

export interface SocketHandlers {
  onFrame: (frame: ServerFrame) => void;
  /** A binary message: audio belonging to the speech currently in flight, and nothing else. */
  onAudio: (data: unknown) => void;
  onClose: () => void;
}

/**
 * The call's WebSocket: frames in and out, and a close that can be told apart from a drop.
 * Reconnecting is a decision (the machine's), not something this class does by itself.
 */
export class LiveSocket {
  private socket: WebSocket | null = null;

  get isOpen(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  /** False when the socket could not even be constructed. */
  open(handlers: SocketHandlers): boolean {
    let socket: WebSocket;
    try {
      socket = new WebSocket(voiceSocketUrl());
    } catch {
      return false;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (e: MessageEvent<unknown>): void => {
      if (typeof e.data === "string") {
        const frame = toServerFrame(e.data);
        if (frame) handlers.onFrame(frame);
        return;
      }
      handlers.onAudio(e.data);
    };
    socket.onclose = (): void => {
      handlers.onClose();
    };
    // A socket error is always followed by a close, which is where the retry lives.
    socket.onerror = (): void => undefined;
    return true;
  }

  send(frame: ClientFrame): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(JSON.stringify(frame));
  }

  /** Blobs and PCM go over the socket as they are, so audio and the frame that closes it keep their order. */
  sendBytes(data: Blob | ArrayBuffer): void {
    if (this.socket?.readyState === SOCKET_OPEN) this.socket.send(data);
  }

  /** Forgets a socket that has already closed itself. */
  forget(): void {
    this.socket = null;
  }

  /** Closes on purpose: silenced first, so the close is not read as a drop. */
  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ type: "bye" } satisfies ClientFrame));
    socket.close();
  }
}
