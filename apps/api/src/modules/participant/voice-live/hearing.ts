import type { SttStreamEvent, SttStreamSession } from "@aidp/shared";
import type { LiveHost } from "./host.js";
import { MAX_ANSWER_CHARS } from "./protocol.js";
import type { SpeechOutput } from "./speech.js";
import type { TurnDriver } from "./turn.js";

/**
 * Streaming transcription (stream mode): the provider's realtime socket, its events, and the way
 * down to per-utterance transcription when it dies.
 */
export class Hearing {
  constructor(
    private readonly host: LiveHost,
    private readonly turns: TurnDriver,
    private readonly speech: SpeechOutput,
  ) {}

  /**
   * Opens the provider's streaming transcription when the tenant has an `stt_stream` route.
   *
   * Any failure here is a fallback, not an error: a bad key, a host that does not speak the
   * Realtime protocol, or a spent budget all leave the per-utterance path, which is what live voice
   * did before streaming existed and which still works.
   */
  async open(settings: { endOfSpeechMs: number; language: string | undefined }): Promise<void> {
    const { host } = this;
    try {
      const caller = await host.ctx.callers.forCompany(host.scope.companyId);
      const stt = await caller.transcribeStream(
        { companyId: host.scope.companyId, sessionId: host.scope.sessionId },
        {
          silenceMs: settings.endOfSpeechMs,
          ...(settings.language ? { language: settings.language } : {}),
        },
      );
      if (!stt) return;
      host.state.stt = stt;
      host.state.mode = "stream";
      void this.pump(stt);
    } catch (err) {
      host.metrics.streamFallbacks++;
      host.ctx.log.warn(
        { err, sessionId: host.scope.sessionId },
        "live voice: streaming transcription unavailable, transcribing per utterance",
      );
    }
  }

  /**
   * Reads the provider's transcription events for as long as the session lasts.
   *
   * The final transcript is handled exactly like a transcribed utterance: captioned, then answered
   * as a normal turn, or held when a turn is already running.
   */
  private async pump(stt: SttStreamSession): Promise<void> {
    const { host } = this;
    try {
      for await (const ev of stt.events) {
        if (host.state.closed) break;
        if (ev.type === "error" && ev.fatal) break;
        // Not awaited: a final transcript runs a whole turn, and the partial captions of whatever
        // the participant says next must keep flowing while it does.
        void host.scoped(() => this.onEvent(ev));
      }
    } catch (err) {
      host.ctx.log.warn({ err, sessionId: host.scope.sessionId }, "live voice: stt stream failed");
    }
    if (host.state.closed || host.state.stt !== stt) return;
    // The events ended without this side closing them: the provider went away mid-call.
    await host.scoped(() => this.fallBack("stt_stream_failed"));
  }

  private async onEvent(ev: SttStreamEvent): Promise<void> {
    const { host } = this;
    const { state } = host;
    switch (ev.type) {
      case "speech_started": {
        state.speechStartedAt = Date.now();
        state.partialSeen = false;
        // The provider hears the participant start talking over the interviewer: the same
        // barge-in the browser's own detector performs, from the other end. `barged` tells the
        // browser the server already did it, so it stops playback without a second `barge`.
        const barged = Boolean(state.speaking) && state.opts.bargeIn;
        if (barged) this.speech.barge();
        host.send({ type: "speech_started", barged });
        return;
      }
      case "speech_stopped":
        state.awaitingFinal = true;
        host.send({ type: "speech_stopped" });
        return;
      case "partial":
        if (!state.partialSeen && state.speechStartedAt !== undefined) {
          state.partialSeen = true;
          host.metrics.firstPartial(Date.now() - state.speechStartedAt);
        }
        if (state.opts.captions) host.send({ type: "caption_partial", text: ev.text });
        return;
      case "final":
        state.awaitingFinal = false;
        await this.onFinal(ev.text, ev.confidence);
        return;
      case "error":
        host.ctx.log.warn({ sessionId: host.scope.sessionId, message: ev.message }, "live voice: stt");
        // A turn the provider could not transcribe is a turn the participant has to repeat.
        if (state.awaitingFinal) {
          state.awaitingFinal = false;
          host.send({ type: "not_heard" });
        }
        return;
    }
  }

  /** Answers a final transcript from the stream, or holds it while a turn is running. */
  private async onFinal(raw: string, confidence: number | undefined): Promise<void> {
    const { host } = this;
    const text = raw.trim();
    if (text.length === 0) {
      host.send({ type: "not_heard" });
      return;
    }
    if (host.state.opts.captions) {
      host.send({
        type: "caption_final",
        role: "user",
        text,
        ...(confidence === undefined ? {} : { confidence }),
      });
    }
    if (host.state.busy) {
      // Keep the most recent one, for the reason `LiveState.hold` gives.
      host.state.hold({ kind: "text", text });
      return;
    }
    await this.turns.takeTurn({ content: text.slice(0, MAX_ANSWER_CHARS), modality: "voice" as const });
  }

  /**
   * Streaming is over for this call: the provider's socket died, or the browser cannot capture PCM.
   * Per-utterance transcription is the rung below it, so the browser is told to capture that way;
   * with no transcription route there is nothing below it but typing.
   */
  async fallBack(reason: "stt_stream_failed" | "client_capture"): Promise<void> {
    const { host } = this;
    const { state } = host;
    const stt = state.stt;
    state.stt = undefined;
    stt?.close();
    host.metrics.streamFallbacks++;
    // Tenant route first, platform second, as the resolver reads them.
    if (await host.ctx.services.turns.hasTranscriptionRoute(host.scope.companyId)) {
      state.mode = "utterance";
      host.gate.reset();
      // A browser that asked for utterance mode is already capturing that way; one the server
      // moved has PCM in flight, which must not be mistaken for the start of a recording.
      state.awaitingCapture = reason === "stt_stream_failed";
      host.send({ type: "mode", mode: "utterance", reason });
      return;
    }
    host.send({ type: "unavailable", reason, fallback: "text" });
  }
}
