import { firstSpokenSentence, remainingSpoken, speechLanguages, toSpokenTurn } from "@aidp/ai";
import type { Widget } from "@aidp/shared";
import { streamTurn } from "../../sessions/turn-runner.js";
import { onProviderFailure } from "./degrade.js";
import type { LiveHost } from "./host.js";
import { CLOSE_POLICY, MAX_ANSWER_CHARS } from "./protocol.js";
import type { SpeechOutput, SpokenReply } from "./speech.js";

/** What the engine is given as the participant's answer; absent for the opening question. */
export interface VoiceAnswer {
  content: string;
  modality: "voice";
}

/**
 * One exchange at a time: transcribe what was said (utterance mode), take an engine turn on it,
 * speak the result, and answer whatever was said while all that ran.
 */
export class TurnDriver {
  constructor(
    private readonly host: LiveHost,
    private readonly speech: SpeechOutput,
  ) {}

  /**
   * False, and the socket closed, once the session is deleted or its tenant suspended (S3, S8).
   * The door was checked when the connection opened; a conversation can outlive that decision.
   */
  async stillAllowed(): Promise<boolean> {
    const { host } = this;
    const status = await host.ctx.services.turns.status(host.scope.companyId, host.scope.sessionId);
    const active = await host.ctx.tenants.isActive(host.scope.companyId);
    if (status !== null && status !== "deleted" && active) return true;
    host.state.close();
    // Closed above, so `send` drops this frame; the close code below is what the browser acts on.
    host.send({ type: "unavailable", reason: "disabled", fallback: "recorded" });
    host.closeSocket(CLOSE_POLICY, "session no longer available");
    return false;
  }

  /**
   * Reads the most recent interviewer question aloud. No engine turn, so nothing is stored and the
   * turn lock is never taken: this is a replay of something the participant can already see.
   */
  async speakLast(): Promise<void> {
    const { host } = this;
    if (host.state.busy) return;
    host.state.busy = true;
    const askedAt = Date.now();
    try {
      if (!(await this.stillAllowed())) return;
      const last = await host.ctx.services.turns.lastInterviewerMessage(
        host.scope.companyId,
        host.scope.sessionId,
      );
      if (!last) {
        // Nothing has been asked yet, so there is nothing to repeat; open the interview instead.
        host.state.busy = false;
        await this.takeTurn(undefined);
        return;
      }
      const widget = last.widget ? (last.widget as Widget) : undefined;
      const spoken = toSpokenTurn(last.content, widget);
      await this.speech.speak(spoken.text, askedAt, spoken.shortened);
    } catch (err) {
      onProviderFailure(host, err, "speech");
    } finally {
      host.state.busy = false;
    }
  }

  /**
   * Runs one engine turn and speaks it.
   *
   * `alreadyBusy` exists because `onUtterance` holds the flag across the transcription too, and
   * releasing it between the two would let a second utterance start a second turn against the same
   * session, which the turn lock would then refuse with an error the participant cannot act on.
   */
  async takeTurn(answer: VoiceAnswer | undefined, alreadyBusy = false): Promise<void> {
    const { host } = this;
    const { state } = host;
    if (!alreadyBusy) {
      if (state.busy) return;
      state.busy = true;
    }
    // Every turn passes here, whatever started it: a control frame, a streamed final from the
    // provider, or an utterance held back while the last turn finished.
    if (!(await this.stillAllowed())) {
      if (!alreadyBusy) state.busy = false;
      return;
    }
    const askedAt = Date.now();
    // Speech starts on the first complete sentence of the streamed message, while the model is
    // still writing its metadata (D-280). `heard` is the text so far; `early` the reply it began.
    let heard = "";
    let early: { reply: SpokenReply; text: string } | undefined;
    try {
      for await (const item of streamTurn(host.ctx, host.scope.sessionId, answer, { signal: host.gone })) {
        if (state.closed) return;
        if (item.event === "text" && !early) {
          heard += (item.data as { delta?: string }).delta ?? "";
          const sentence = firstSpokenSentence(heard);
          if (sentence) {
            const reply = this.speech.reply(askedAt);
            early = { reply, text: sentence };
            void reply.say(sentence, false, false);
          }
        } else if (item.event === "turn") {
          const data = item.data as {
            message: { content: string };
            ended: boolean;
            progress: unknown;
            voiceShortForm?: string;
            widget?: Widget;
          };
          host.metrics.turns++;
          host.send({ type: "turn", ...data });
          if (state.opts.captions) {
            host.send({ type: "caption", role: "assistant", text: data.message.content });
          }
          if (early) {
            // What was said is the written message's own opening, so the rest is cut from the
            // same rendering and the spoken words stay the displayed words. The model's short form
            // would replace the message and repeat what was already heard, so it is not used here.
            const rest = remainingSpoken(toSpokenTurn(data.message.content, data.widget), early.text);
            const reply = early.reply;
            early = undefined;
            await reply.say(rest.text, rest.shortened, true);
          } else {
            const spoken = toSpokenTurn(data.message.content, data.widget, data.voiceShortForm);
            await this.speech.speak(spoken.text, askedAt, spoken.shortened);
          }
        } else if (item.event === "ended") {
          host.send({ type: "ended", ...(item.data as object) });
        } else if (item.event === "error") {
          // A sentence already spoken for a turn that did not complete is not in the transcript.
          early?.reply.cancel();
          early = undefined;
          host.send({ type: "error", ...(item.data as object) });
        }
        // Other `text` deltas are not forwarded: the participant is listening, not reading a stream.
      }
    } catch (err) {
      early?.reply.cancel();
      onProviderFailure(host, err, "turn");
    } finally {
      // A turn that ended without its `turn` event (the caller left, the lock was lost) leaves no
      // sentence in the transcript, so nothing of it is left playing.
      early?.reply.cancel();
      if (!alreadyBusy) {
        state.busy = false;
        await this.drainPending();
      }
    }
  }

  /** Transcribe what was said, then take a turn on it. */
  async onUtterance(): Promise<void> {
    const { host } = this;
    const { state } = host;
    const audio = host.gate.take();
    if (audio.byteLength === 0) return;
    if (state.busy) {
      state.hold({ kind: "audio", audio });
      return;
    }

    state.busy = true;
    try {
      // Before the transcription, which is paid for, not only before the turn that follows it.
      if (!(await this.stillAllowed())) return;
      const caller = await host.ctx.callers.forCompany(host.scope.companyId);
      const transcript = await caller.transcribe(
        { companyId: host.scope.companyId, sessionId: host.scope.sessionId },
        {
          data: new Uint8Array(audio),
          mime: "audio/webm",
          filename: "utterance.webm",
          languages: speechLanguages(await host.ctx.attachments.languageFor(host.scope.sessionId)),
        },
      );
      const text = transcript.text.trim();
      if (text.length === 0) {
        // Silence, or a microphone picking up nothing. Say so rather than sending an empty answer,
        // which would make the interviewer ask a confused follow-up.
        host.send({ type: "not_heard" });
        return;
      }
      if (state.opts.captions) {
        host.send({
          type: "caption",
          role: "user",
          text,
          ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence }),
        });
      }
      await this.takeTurn({ content: text.slice(0, MAX_ANSWER_CHARS), modality: "voice" as const }, true);
    } catch (err) {
      onProviderFailure(host, err, "transcription");
    } finally {
      state.busy = false;
      await this.drainPending();
    }
  }

  /** Answers whatever was said mid-turn, now that the turn is over. */
  async drainPending(): Promise<void> {
    const { host } = this;
    const held = host.state.takeHeld();
    if (!held) return;
    if (held.kind === "text") {
      await this.takeTurn({ content: held.text.slice(0, MAX_ANSWER_CHARS), modality: "voice" as const });
      return;
    }
    host.gate.restore(held.audio);
    await this.onUtterance();
  }
}
