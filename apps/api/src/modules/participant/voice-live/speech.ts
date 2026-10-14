import { onProviderFailure } from "./degrade.js";
import type { LiveHost } from "./host.js";

/** The interviewer's voice: synthesis streamed to the browser, and cutting it off on barge-in. */
export class SpeechOutput {
  constructor(private readonly host: LiveHost) {}

  /**
   * Stop talking immediately. This is the whole point of barge-in: a participant who starts
   * answering should not have to wait for the interviewer to finish a sentence.
   */
  barge(): void {
    this.host.metrics.interruption();
    this.host.state.speaking?.abort();
    this.host.send({ type: "speech_end", interrupted: true });
  }

  /**
   * Synthesizes and streams the interviewer's voice.
   *
   * Falls back rather than failing: with no `tts` route the client is told to carry on with
   * captions only, which is the middle rung of the spec's real-time → recorded → text chain. The
   * interview continues either way — that is the requirement, "without losing the session".
   */
  async speak(text: string, askedAt: number, shortened: boolean): Promise<void> {
    if (text.length === 0) return;
    const { host } = this;
    const { state } = host;
    const controller = new AbortController();
    state.speaking = controller;
    try {
      const caller = await host.ctx.callers.forCompany(host.scope.companyId);
      const out = await caller.speak(
        { companyId: host.scope.companyId, sessionId: host.scope.sessionId },
        { text, voice: state.opts.voice, speed: state.opts.speed, format: "opus" },
        controller.signal,
      );
      if (!out) {
        host.send({ type: "unavailable", reason: "no_tts_route", fallback: "captions" });
        return;
      }
      host.send({ type: "speech_start", mime: out.mime, shortened });
      let first = true;
      for await (const chunk of out.audio) {
        if (state.closed || controller.signal.aborted) break;
        if (first) {
          const ms = Date.now() - askedAt;
          host.metrics.firstWord(ms, state.mode);
          host.send({ type: "first_word", ms });
          first = false;
        }
        host.sendAudio(chunk);
      }
      if (!controller.signal.aborted) host.send({ type: "speech_end", interrupted: false });
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in, not a failure
      onProviderFailure(host, err, "speech");
    } finally {
      if (state.speaking === controller) state.speaking = undefined;
    }
  }
}
