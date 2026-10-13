import type { RouteContext } from "../../../context.js";
import type { AudioGate } from "./audio-gate.js";
import type { VoiceMetrics } from "./metrics.js";
import type { LiveState } from "./state.js";

export interface Scope {
  companyId: string;
  sessionId: string;
}

/**
 * What the parts of a live call may ask of the call that owns them. The socket, the abort handle
 * and the tenant scope stay behind this, so the hearing, turn and speech parts can be driven in a
 * test by a host that records frames instead of writing to a connection.
 */
export interface LiveHost {
  readonly ctx: RouteContext;
  readonly scope: Scope;
  readonly state: LiveState;
  readonly gate: AudioGate;
  readonly metrics: VoiceMetrics;
  /** Aborted when the socket closes or errors: a turn in flight stops and is recorded as aborted. */
  readonly gone: AbortSignal;
  /**
   * Runs `fn` inside the call's tenant. A socket callback is invoked by the event loop, not by
   * the request, so the tenant the auth hook entered is gone by then; each entry point re-enters.
   */
  scoped<T>(fn: () => Promise<T>): Promise<T>;
  /** A JSON control frame to the browser. A no-op once the call is closed. */
  send(payload: Record<string, unknown>): void;
  /** One chunk of synthesized speech. */
  sendAudio(chunk: Uint8Array): void;
  closeSocket(code: number, reason: string): void;
}
