import { ProviderError, toSpokenTurn } from "@aidp/ai";
import { withTenant } from "@aidp/db";
import type { Widget } from "@aidp/shared";
import type { WebSocket } from "@fastify/websocket";
import { z } from "zod";
import type { App } from "../../app.js";
import type { AppContext } from "../../context.js";
import { streamTurn } from "../sessions/turn-runner.js";

/**
 * The real-time voice cascade (FR-30a): streaming speech in, the engine, streaming speech out.
 *
 * The engine stays the brain. Nothing here decides what to ask; it turns audio into an answer,
 * hands that answer to exactly the same turn the text interview runs, and speaks the result. Every
 * exchange is still an ordinary `Message` row, so a session can be started by voice, continued by
 * typing, and analyzed without anything downstream knowing the difference.
 *
 * **Why a WebSocket, and why it is reached directly.** Every other browser call goes through the
 * Next.js proxy, which keeps the API off the internet. Next.js route handlers cannot upgrade a
 * connection, so live voice is the one path Caddy sends to the API itself. It is authenticated by
 * the same `aidp_participant` cookie the proxy sets — same site, so the browser attaches it — and
 * the socket can do nothing a participant could not already do over HTTP.
 *
 * **Where the speech-to-text actually streams.** The browser detects the end of an utterance
 * locally (silence) and sends that utterance as one piece, which is transcribed through the
 * `transcription` route. Partial words do not appear as the participant speaks; a caption appears
 * when they stop. Token-level streaming needs a provider-specific socket protocol (Deepgram,
 * AssemblyAI, a self-hosted Whisper server) and the `Provider` interface has no method for it
 * yet — that is the honest boundary of what is built, and it is the piece to add next.
 */

/** Frames the browser sends. Audio arrives as binary; everything else is one of these. */
const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  /**
   * Speak the question already on screen, without taking a turn.
   *
   * Someone who switches to voice part-way through an interview arrives to a question that has
   * already been asked in text. `start` would ask a new one, which is wrong: they have not
   * answered the current one yet. This reads the existing one aloud so the call begins where the
   * conversation actually is.
   */
  z.object({ type: z.literal("speak_last") }),
  /** The participant stopped talking; transcribe what has been sent and take a turn. */
  z.object({ type: z.literal("utterance"), durationMs: z.number().int().min(0).max(600_000).optional() }),
  /** The participant started talking over the interviewer. */
  z.object({ type: z.literal("barge") }),
  /** Discard buffered audio without taking a turn (they changed their mind). */
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("bye") }),
]);

/** A single utterance may not exceed this before the server stops accepting audio for it. */
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

/** Beyond this the socket is closed: something is sending audio that never ends. */
const MAX_SESSION_BYTES = 200 * 1024 * 1024;

const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

export async function participantVoiceLiveRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get("/p/session/live", { websocket: true, schema: { hide: true } }, (socket, req) => {
    // The principal comes from the auth plugin's onRequest hook, exactly as on every HTTP route;
    // an upgraded request goes through the same lifecycle. The check is inline rather than the
    // usual `requireParticipant` preHandler because a refused socket has to be closed with a
    // status code, and a thrown AppError would try to write a JSON body to a connection the
    // browser is expecting to upgrade.
    const principal = req.principal;
    if (principal.kind !== "participant") {
      socket.close(CLOSE_POLICY, "participant session required");
      return;
    }
    void new LiveVoiceSession(ctx, socket, {
      companyId: principal.companyId,
      sessionId: principal.sessionId,
    }).run();
  });
}

interface Scope {
  companyId: string;
  sessionId: string;
}

/**
 * One live conversation.
 *
 * Holds the buffered audio of the utterance in progress, the abort handle for the speech currently
 * playing, and the counters the spec asks to trace. Everything is per-socket; nothing is shared.
 */
class LiveVoiceSession {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private sessionBytes = 0;
  private busy = false;
  /**
   * An utterance that arrived while a turn was still running.
   *
   * Dropping it would be wrong in the most ordinary case there is: the participant hears the
   * question, starts answering immediately, and the interviewer is still speaking. Barge-in means
   * exactly that is expected. The audio is held and answered as soon as the turn in flight ends.
   */
  private pending: Buffer | undefined;
  private closed = false;
  /** Aborts the synthesis in flight. Replaced on every turn, called on barge-in. */
  private speaking: AbortController | undefined;
  private interruptions = 0;
  private turns = 0;
  private firstWordMsTotal = 0;
  private firstWordSamples = 0;

  constructor(
    private readonly ctx: AppContext,
    private readonly socket: WebSocket,
    private readonly scope: Scope,
  ) {}

  /**
   * Everything this session does runs inside its tenant's scope.
   *
   * The auth plugin enters that scope in an `onRequest` hook, which covers the upgrade request and
   * nothing after it: the tenant lives in an `AsyncLocalStorage` and a socket's `message` callback
   * is invoked by the event loop, not by the request, so the context is gone by the time any of
   * this runs. Row-level security then refuses every query, and the first symptom is the session
   * row apparently not existing. Each entry point re-enters explicitly.
   */
  private scoped<T>(fn: () => Promise<T>): Promise<T> {
    return withTenant(this.scope.companyId, fn);
  }

  async run(): Promise<void> {
    const { captions, bargeIn, voice, speed, enabled } = await this.scoped(() => this.settings());
    if (!enabled) {
      this.send({ type: "unavailable", reason: "disabled", fallback: "recorded" });
      this.socket.close(CLOSE_POLICY, "live voice is turned off");
      return;
    }
    this.send({ type: "ready", captions, bargeIn });

    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      void this.scoped(() => this.onMessage(data, isBinary, { captions, voice, speed }));
    });
    this.socket.on("close", () => {
      this.closed = true;
      this.speaking?.abort();
      void this.scoped(() => this.recordMetrics());
    });
    this.socket.on("error", () => {
      this.closed = true;
      this.speaking?.abort();
    });
  }

  private async onMessage(
    data: Buffer,
    isBinary: boolean,
    opts: { captions: boolean; voice: string; speed: number },
  ): Promise<void> {
    if (this.closed) return;
    if (isBinary) {
      this.collect(data);
      return;
    }
    const parsed = ClientFrame.safeParse(safeJson(data.toString("utf8")));
    if (!parsed.success) return;
    const frame = parsed.data;

    switch (frame.type) {
      case "start":
        // The opening question, spoken. No answer, so the engine asks its first thing.
        await this.takeTurn(undefined, opts);
        return;
      case "speak_last":
        await this.speakLast(opts);
        return;
      case "barge":
        // Stop talking immediately. This is the whole point of barge-in: a participant who starts
        // answering should not have to wait for the interviewer to finish a sentence.
        this.interruptions++;
        this.speaking?.abort();
        this.send({ type: "speech_end", interrupted: true });
        return;
      case "cancel":
        this.reset();
        return;
      case "utterance":
        await this.onUtterance(opts);
        return;
      case "bye":
        this.socket.close(1000, "bye");
        return;
    }
  }

  /**
   * Reads the most recent interviewer question aloud. No engine turn, so nothing is stored and the
   * turn lock is never taken: this is a replay of something the participant can already see.
   */
  private async speakLast(opts: { captions: boolean; voice: string; speed: number }): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const askedAt = Date.now();
    try {
      const last = await this.ctx.db.message.findFirst({
        where: { sessionId: this.scope.sessionId, role: "assistant" },
        orderBy: { seq: "desc" },
        select: { content: true, widget: true },
      });
      if (!last) {
        // Nothing has been asked yet, so there is nothing to repeat; open the interview instead.
        this.busy = false;
        await this.takeTurn(undefined, opts);
        return;
      }
      const widget = last.widget ? (last.widget as Widget) : undefined;
      const spoken = toSpokenTurn(last.content, widget);
      await this.speak(spoken.text, opts, askedAt, spoken.shortened);
    } catch (err) {
      this.onProviderFailure(err, "speech");
    } finally {
      this.busy = false;
    }
  }

  private collect(data: Buffer): void {
    this.sessionBytes += data.byteLength;
    if (this.sessionBytes > MAX_SESSION_BYTES) {
      this.socket.close(CLOSE_TOO_BIG, "too much audio");
      this.closed = true;
      return;
    }
    if (this.bytes + data.byteLength > MAX_UTTERANCE_BYTES) return; // drop the tail, keep the head
    this.chunks.push(data);
    this.bytes += data.byteLength;
  }

  private reset(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  /** Transcribe what was said, then take a turn on it. */
  private async onUtterance(opts: { captions: boolean; voice: string; speed: number }): Promise<void> {
    const audio = Buffer.concat(this.chunks);
    this.reset();
    if (audio.byteLength === 0) return;
    if (this.busy) {
      // Keep the most recent one. If they said two things while the interviewer was talking, the
      // second is the one they meant; answering the first would put the conversation a turn behind.
      this.pending = audio;
      return;
    }

    this.busy = true;
    try {
      const caller = await this.ctx.callers.forCompany(this.scope.companyId);
      const transcript = await caller.transcribe(
        { companyId: this.scope.companyId, sessionId: this.scope.sessionId },
        { data: new Uint8Array(audio), mime: "audio/webm", filename: "utterance.webm" },
      );
      const text = transcript.text.trim();
      if (text.length === 0) {
        // Silence, or a microphone picking up nothing. Say so rather than sending an empty answer,
        // which would make the interviewer ask a confused follow-up.
        this.send({ type: "not_heard" });
        return;
      }
      if (opts.captions) {
        this.send({
          type: "caption",
          role: "user",
          text,
          ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence }),
        });
      }
      await this.takeTurn({ content: text.slice(0, 8000), modality: "voice" as const }, opts, true);
    } catch (err) {
      this.onProviderFailure(err, "transcription");
    } finally {
      this.busy = false;
      await this.drainPending(opts);
    }
  }

  /**
   * Runs one engine turn and speaks it.
   *
   * `alreadyBusy` exists because `onUtterance` holds the flag across the transcription too, and
   * releasing it between the two would let a second utterance start a second turn against the same
   * session, which the turn lock would then refuse with an error the participant cannot act on.
   */
  private async takeTurn(
    answer: { content: string; modality: "voice" } | undefined,
    opts: { captions: boolean; voice: string; speed: number },
    alreadyBusy = false,
  ): Promise<void> {
    if (!alreadyBusy) {
      if (this.busy) return;
      this.busy = true;
    }
    const askedAt = Date.now();
    try {
      for await (const item of streamTurn(this.ctx, this.scope.sessionId, answer)) {
        if (this.closed) return;
        if (item.event === "turn") {
          const data = item.data as {
            message: { content: string };
            ended: boolean;
            progress: unknown;
            voiceShortForm?: string;
            widget?: Widget;
          };
          this.turns++;
          this.send({ type: "turn", ...data });
          const spoken = toSpokenTurn(data.message.content, data.widget, data.voiceShortForm);
          if (opts.captions) {
            this.send({ type: "caption", role: "assistant", text: data.message.content });
          }
          await this.speak(spoken.text, opts, askedAt, spoken.shortened);
        } else if (item.event === "ended") {
          this.send({ type: "ended", ...(item.data as object) });
        } else if (item.event === "error") {
          this.send({ type: "error", ...(item.data as object) });
        }
        // `text` deltas are not forwarded: the participant is listening, not reading a stream, and
        // speech cannot begin until the sentence is complete anyway.
      }
    } catch (err) {
      this.onProviderFailure(err, "turn");
    } finally {
      if (!alreadyBusy) {
        this.busy = false;
        await this.drainPending(opts);
      }
    }
  }

  /** Answers an utterance that arrived mid-turn, now that the turn is over. */
  private async drainPending(opts: { captions: boolean; voice: string; speed: number }): Promise<void> {
    const audio = this.pending;
    if (!audio || this.closed) return;
    this.pending = undefined;
    this.chunks.push(audio);
    this.bytes = audio.byteLength;
    await this.onUtterance(opts);
  }

  /**
   * Synthesizes and streams the interviewer's voice.
   *
   * Falls back rather than failing: with no `tts` route the client is told to carry on with
   * captions only, which is the middle rung of the spec's real-time → recorded → text chain. The
   * interview continues either way — that is the requirement, "without losing the session".
   */
  private async speak(
    text: string,
    opts: { voice: string; speed: number },
    askedAt: number,
    shortened: boolean,
  ): Promise<void> {
    if (text.length === 0) return;
    const controller = new AbortController();
    this.speaking = controller;
    try {
      const caller = await this.ctx.callers.forCompany(this.scope.companyId);
      const out = await caller.speak(
        { companyId: this.scope.companyId, sessionId: this.scope.sessionId },
        { text, voice: opts.voice, speed: opts.speed, format: "opus" },
        controller.signal,
      );
      if (!out) {
        this.send({ type: "unavailable", reason: "no_tts_route", fallback: "captions" });
        return;
      }
      this.send({ type: "speech_start", mime: out.mime, shortened });
      let first = true;
      for await (const chunk of out.audio) {
        if (this.closed || controller.signal.aborted) break;
        if (first) {
          // The number the spec puts a target on: question asked to first audible word.
          const ms = Date.now() - askedAt;
          this.firstWordMsTotal += ms;
          this.firstWordSamples++;
          this.send({ type: "first_word", ms });
          first = false;
        }
        this.socket.send(chunk);
      }
      if (!controller.signal.aborted) this.send({ type: "speech_end", interrupted: false });
    } catch (err) {
      if (controller.signal.aborted) return; // barge-in, not a failure
      this.onProviderFailure(err, "speech");
    } finally {
      if (this.speaking === controller) this.speaking = undefined;
    }
  }

  /**
   * A provider that cannot do its half of the cascade drops the participant down the chain rather
   * than ending the interview.
   */
  private onProviderFailure(err: unknown, stage: "transcription" | "speech" | "turn"): void {
    const unsupported = err instanceof ProviderError && err.code === "unsupported";
    this.ctx.log.warn({ err, stage, sessionId: this.scope.sessionId }, "live voice degraded");
    this.send({
      type: "unavailable",
      reason: unsupported ? `no_${stage}_route` : `${stage}_failed`,
      fallback: this.fallbackFor(stage, unsupported),
    });
  }

  /**
   * Which rung of the chain to drop to.
   *
   * The distinction that matters is between a missing route and a provider having a bad minute.
   * Recorded voice and live voice transcribe through the same `transcription` route, so when that
   * route does not exist, telling the participant to press the record button instead sends them at
   * the one thing guaranteed to fail the same way. The honest answer there is typing. A
   * transcription that merely *failed* is worth retrying by hand, so that one does point at the
   * button. Losing the interviewer's voice is different again: the call still works, in captions.
   */
  private fallbackFor(
    stage: "transcription" | "speech" | "turn",
    unsupported: boolean,
  ): "text" | "recorded" | "captions" {
    if (stage !== "transcription") return "captions";
    return unsupported ? "text" : "recorded";
  }

  /** The three signals spec 09 asks to trace per session, written once at the end. */
  private async recordMetrics(): Promise<void> {
    if (this.turns === 0) return;
    const avgFirstWordMs =
      this.firstWordSamples > 0 ? Math.round(this.firstWordMsTotal / this.firstWordSamples) : null;
    await this.ctx.db.sessionEvent
      .create({
        data: {
          sessionId: this.scope.sessionId,
          seq: Date.now() % 2_147_483_647,
          type: "voice.live",
          payload: {
            turns: this.turns,
            interruptions: this.interruptions,
            avgFirstWordMs,
            audioBytes: this.sessionBytes,
          },
        },
      })
      .catch(() => undefined);
  }

  private async settings(): Promise<{
    enabled: boolean;
    captions: boolean;
    bargeIn: boolean;
    voice: string;
    speed: number;
  }> {
    const chain = [{ scope: "tenant" as const, scopeId: this.scope.companyId }];
    const values = await this.ctx.settings.resolveMany(
      ["features.realtimeVoice", "voice.captions", "voice.bargeIn", "voice.voiceName", "voice.speakingRate"],
      chain,
    );
    return {
      enabled: values["features.realtimeVoice"] as boolean,
      captions: values["voice.captions"] as boolean,
      bargeIn: values["voice.bargeIn"] as boolean,
      voice: values["voice.voiceName"] as string,
      speed: values["voice.speakingRate"] as number,
    };
  }

  private send(payload: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.socket.send(JSON.stringify(payload));
    } catch {
      // The socket went away between the check and the write. Nothing useful to do.
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
