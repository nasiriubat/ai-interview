import { onProviderFailure } from "./degrade.js";
import type { LiveHost } from "./host.js";

/**
 * One spoken reply: one or more segments, said in order, that the browser plays back to back.
 *
 * A reply is one segment when the whole text is known (a replayed question). It is two when speech
 * starts on the first sentence while the model is still writing its metadata (D-280): the first
 * segment goes out with `speech_end { more: true }`, so the client keeps the interviewer "speaking"
 * and queues the next one behind it. `first_word` is measured once, at the first audio byte of the
 * first segment, from the moment the turn was asked for.
 */
export class SpokenReply {
  private readonly controller = new AbortController();
  private chain: Promise<void> = Promise.resolve();
  private firstWordSent = false;
  private started = false;
  private finished = false;
  /** Set when a segment could not be produced; later segments are skipped rather than spoken out of order. */
  private broken = false;

  constructor(
    private readonly host: LiveHost,
    private readonly askedAt: number,
  ) {
    host.state.speaking = this.controller;
  }

  get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Queues a segment. `final` closes the reply: the browser plays the queue out and goes back to
   * listening only after the segment that carried it. Segments are synthesized one after another,
   * so what is heard is in the order it was written.
   */
  say(text: string, shortened: boolean, final: boolean): Promise<void> {
    this.chain = this.chain.then(() => this.segment(text, shortened, final));
    return this.chain;
  }

  /**
   * Ends a reply that will not get its final segment (the turn failed or was cut off). If the
   * browser was already told to expect more, it is told the speech stopped, so it does not wait.
   */
  cancel(): void {
    if (this.finished) return;
    const { host } = this;
    const heard = this.started;
    this.finish();
    this.controller.abort();
    if (heard && !host.state.closed) host.send({ type: "speech_end", interrupted: true });
  }

  private finish(): void {
    this.finished = true;
    const { state } = this.host;
    if (state.speaking === this.controller) state.speaking = undefined;
  }

  private async segment(text: string, shortened: boolean, final: boolean): Promise<void> {
    const { host, controller } = this;
    const { state } = host;
    if (this.finished || this.broken || controller.signal.aborted || state.closed) {
      if (final) this.finish();
      return;
    }
    if (text.length === 0) {
      // Nothing left to say after a segment that promised more: close the speech so the browser plays.
      if (this.started) host.send({ type: "speech_end", interrupted: false, more: false });
      if (final) this.finish();
      return;
    }
    try {
      const caller = await host.ctx.callers.forCompany(host.scope.companyId);
      const out = await caller.speak(
        { companyId: host.scope.companyId, sessionId: host.scope.sessionId },
        { text, voice: state.opts.voice, speed: state.opts.speed, format: "opus" },
        controller.signal,
      );
      if (!out) {
        // The middle rung of the spec's real-time, recorded, text chain: captions only.
        this.broken = true;
        host.send({ type: "unavailable", reason: "no_tts_route", fallback: "captions" });
        return;
      }
      host.send({ type: "speech_start", mime: out.mime, shortened });
      this.started = true;
      let first = true;
      for await (const chunk of out.audio) {
        if (state.closed || controller.signal.aborted) break;
        if (first && !this.firstWordSent) {
          const ms = Date.now() - this.askedAt;
          host.metrics.firstWord(ms, state.mode);
          host.send({ type: "first_word", ms });
          this.firstWordSent = true;
        }
        first = false;
        host.sendAudio(chunk);
      }
      if (!controller.signal.aborted) host.send({ type: "speech_end", interrupted: false, more: !final });
    } catch (err) {
      this.broken = true;
      if (controller.signal.aborted) return; // barge-in, not a failure
      if (this.started) host.send({ type: "speech_end", interrupted: true });
      onProviderFailure(host, err, "speech");
    } finally {
      if (final || this.broken) this.finish();
    }
  }
}

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

  /** Starts a reply whose clock began at `askedAt`; say its segments, the last one `final`. */
  reply(askedAt: number): SpokenReply {
    return new SpokenReply(this.host, askedAt);
  }

  /**
   * Synthesizes and streams the interviewer's voice for text that is known in full.
   *
   * Falls back rather than failing: with no `tts` route the client is told to carry on with
   * captions only, which is the middle rung of the spec's real-time, recorded, text chain. The
   * interview continues either way: that is the requirement, "without losing the session".
   */
  async speak(text: string, askedAt: number, shortened: boolean): Promise<void> {
    if (text.length === 0) return;
    await this.reply(askedAt).say(text, shortened, true);
  }
}
