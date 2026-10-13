import { withTenant } from "@aidp/db";
import { STT_STREAM_SAMPLE_RATE } from "@aidp/shared";
import type { WebSocket } from "@fastify/websocket";
import type { RouteContext } from "../../../context.js";
import { AudioGate } from "./audio-gate.js";
import { Hearing } from "./hearing.js";
import type { LiveHost, Scope } from "./host.js";
import { VoiceMetrics } from "./metrics.js";
import {
  CLOSE_POLICY,
  CLOSE_TOO_BIG,
  MAX_SESSION_BYTES,
  MAX_STREAM_SESSION_BYTES,
  parseClientFrame,
} from "./protocol.js";
import { SpeechOutput } from "./speech.js";
import { LiveState, type SessionOpts } from "./state.js";
import { TurnDriver } from "./turn.js";

/**
 * One live conversation.
 *
 * Owns the socket and wires the parts: `Hearing` (the provider's streaming transcription),
 * `TurnDriver` (transcribe, take a turn, answer what was held), and `SpeechOutput` (the voice).
 * They share `LiveState`, `AudioGate` and `VoiceMetrics`; everything is per-socket, nothing is
 * shared between calls.
 */
export class LiveVoiceSession implements LiveHost {
  readonly state = new LiveState();
  readonly gate = new AudioGate();
  readonly metrics = new VoiceMetrics();
  /**
   * Aborted when the socket closes or errors, and handed to the turn: a participant who hangs up
   * mid-turn must stop the model call in flight, not leave it to run to completion and be billed.
   */
  private readonly abortController = new AbortController();
  private readonly speech: SpeechOutput;
  private readonly turns: TurnDriver;
  private readonly hearing: Hearing;

  constructor(
    readonly ctx: RouteContext,
    private readonly socket: WebSocket,
    readonly scope: Scope,
  ) {
    this.speech = new SpeechOutput(this);
    this.turns = new TurnDriver(this, this.speech);
    this.hearing = new Hearing(this, this.turns, this.speech);
  }

  get gone(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Everything this session does runs inside its tenant's scope.
   *
   * The auth plugin enters that scope in an `onRequest` hook, which covers the upgrade request and
   * nothing after it: the tenant lives in an `AsyncLocalStorage` and a socket's `message` callback
   * is invoked by the event loop, not by the request, so the context is gone by the time any of
   * this runs. Row-level security then refuses every query, and the first symptom is the session
   * row apparently not existing. Each entry point re-enters explicitly.
   */
  scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withTenant(this.scope.companyId, fn);
  }

  async run(): Promise<void> {
    // Listeners first: the provider socket takes a moment to open, and a participant who hangs up
    // in that moment must not leave it open behind them.
    this.socket.on("close", () => {
      this.hangUp();
      void this.scoped(() => this.recordMetrics());
    });
    this.socket.on("error", () => {
      this.hangUp();
    });

    const settings = await this.scoped(() => this.settings());
    if (!settings.enabled) {
      this.send({ type: "unavailable", reason: "disabled", fallback: "recorded" });
      this.socket.close(CLOSE_POLICY, "live voice is turned off");
      return;
    }
    this.state.opts = settings;
    await this.scoped(() => this.hearing.open(settings));
    if (this.state.closed) {
      this.state.stt?.close();
      return;
    }
    this.send({
      type: "ready",
      captions: settings.captions,
      bargeIn: settings.bargeIn,
      mode: this.state.mode,
      ...(this.state.mode === "stream" ? { sampleRate: STT_STREAM_SAMPLE_RATE } : {}),
    });

    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      void this.scoped(() => this.onMessage(data, isBinary));
    });
  }

  /** The socket went away: stop the turn, the speech and the provider's socket. */
  private hangUp(): void {
    this.abortController.abort();
    this.state.close();
  }

  private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
    const { state } = this;
    if (state.closed) return;
    if (isBinary) {
      if (state.awaitingCapture) return;
      if (state.mode === "stream") this.stream(data);
      else this.collect(data);
      return;
    }
    const frame = parseClientFrame(data);
    if (!frame) return;
    // Not re-checked here: awaiting a query before a `capture` or `cancel` frame is handled would
    // let the binary frames behind it overtake it. The checks sit where a turn is begun
    // (`takeTurn`), where audio is paid for (`onUtterance`) and where text is replayed.
    switch (frame.type) {
      case "start":
        // The opening question, spoken. No answer, so the engine asks its first thing.
        await this.turns.takeTurn(undefined);
        return;
      case "speak_last":
        await this.turns.speakLast();
        return;
      case "barge":
        this.speech.barge();
        return;
      case "cancel":
        this.gate.reset();
        return;
      case "utterance":
        if (state.mode === "utterance") await this.turns.onUtterance();
        return;
      case "capture":
        if (frame.mode === state.mode) state.awaitingCapture = false;
        // Asked to stream, and this browser cannot capture PCM (no AudioWorklet): the rung below.
        else if (frame.mode === "utterance") await this.hearing.fallBack("client_capture");
        return;
      case "bye":
        this.socket.close(1000, "bye");
        return;
    }
  }

  /** Counts audio against the session's ceiling; false when the socket had to be closed. */
  private admit(data: Buffer, ceiling: number): boolean {
    if (this.gate.admit(data.byteLength, ceiling)) return true;
    this.socket.close(CLOSE_TOO_BIG, "too much audio");
    this.state.closed = true;
    this.state.stt?.close();
    return false;
  }

  private collect(data: Buffer): void {
    if (!this.admit(data, MAX_SESSION_BYTES)) return;
    this.gate.append(data);
  }

  /** Stream mode: PCM16 goes straight to the provider, nothing is buffered here. */
  private stream(data: Buffer): void {
    if (!this.admit(data, MAX_STREAM_SESSION_BYTES)) return;
    this.state.stt?.push(AudioGate.evenPcm(data));
  }

  /** The signals spec 09 asks to trace per session, written once at the end. */
  private async recordMetrics(): Promise<void> {
    const row = this.metrics.snapshot(this.state.mode, this.gate.sessionBytes);
    if (!row) return;
    await this.ctx.services.turns.recordVoiceMetrics(this.scope.companyId, this.scope.sessionId, row);
  }

  private async settings(): Promise<
    SessionOpts & { enabled: boolean; endOfSpeechMs: number; language: string | undefined }
  > {
    const chain = [{ scope: "tenant" as const, scopeId: this.scope.companyId }];
    const [values, language] = await Promise.all([
      this.ctx.settings.resolveMany(
        [
          "features.realtimeVoice",
          "voice.captions",
          "voice.bargeIn",
          "voice.voiceName",
          "voice.speakingRate",
          "voice.endOfSpeechMs",
        ],
        chain,
      ),
      this.ctx.services.turns.templateLanguage(this.scope.companyId, this.scope.sessionId),
    ]);
    return {
      enabled: values["features.realtimeVoice"] as boolean,
      captions: values["voice.captions"] as boolean,
      bargeIn: values["voice.bargeIn"] as boolean,
      voice: values["voice.voiceName"] as string,
      speed: values["voice.speakingRate"] as number,
      endOfSpeechMs: values["voice.endOfSpeechMs"] as number,
      language,
    };
  }

  send(payload: Record<string, unknown>): void {
    if (this.state.closed) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // The socket went away between the check and the write. Nothing useful to do.
    }
  }

  sendAudio(chunk: Uint8Array): void {
    this.socket.send(chunk);
  }

  closeSocket(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
}
