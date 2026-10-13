import { ProviderError, speechLanguages, toSpokenTurn, UnsupportedAudioError } from "@aidp/ai";
import { withTenant } from "@aidp/db";
import {
  STT_STREAM_SAMPLE_RATE,
  type SttStreamEvent,
  type SttStreamSession,
  type Widget,
} from "@aidp/shared";
import type { WebSocket } from "@fastify/websocket";
import { z } from "zod";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
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
 * **Two ways to hear, announced in `ready.mode`.** With an `stt_stream` route (D-77) the browser
 * streams PCM16 at 24 kHz continuously; this pipes it to the provider's realtime transcription
 * socket, forwards the growing text as `caption_partial` while the participant is still talking,
 * and on the provider's final transcript takes the turn. Without one, or when that socket cannot
 * be opened, the call runs in `utterance` mode: the browser detects the end of speech itself and
 * sends each utterance as one recording for the `transcription` route (D-70). A streaming session
 * that dies mid-call drops to `utterance` mode with a `mode` frame, when there is a transcription
 * route to drop to; otherwise the participant is pointed at typing.
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
  /**
   * The browser has switched its capture to what the server asked for in a `mode` frame. Until it
   * says so, binary frames are the old format in flight and are dropped rather than transcribed.
   */
  z.object({ type: z.literal("capture"), mode: z.enum(["stream", "utterance"]) }),
]);

/** How the participant's speech reaches the transcriber; the server decides and says so in `ready`. */
type HearingMode = "stream" | "utterance";

/** Something the participant said while a turn was running: a recording, or an already-final transcript. */
type Held = { kind: "audio"; audio: Buffer } | { kind: "text"; text: string };

/** A single utterance may not exceed this before the server stops accepting audio for it. */
const MAX_UTTERANCE_BYTES = 8 * 1024 * 1024;

/** Beyond this the socket is closed: something is sending audio that never ends. */
const MAX_SESSION_BYTES = 200 * 1024 * 1024;

/**
 * Stream mode sends raw PCM16 at 24 kHz, 48 kB a second whether anyone is talking or not, so its
 * ceiling is time rather than utterances: two hours of continuous audio.
 */
const MAX_STREAM_SESSION_BYTES = 2 * 60 * 60 * STT_STREAM_SAMPLE_RATE * 2;

const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;

export async function participantVoiceLiveRoutes(app: App, ctx: AppContext): Promise<void> {
  app.get(
    "/p/session/live",
    { ...guard.participantSocket(), websocket: true, schema: { hide: true } },
    (socket, req) => {
      // The principal comes from the auth plugin's onRequest hook, exactly as on every HTTP route;
      // an upgraded request goes through the same lifecycle. The check is inline rather than a
      // guard hook because a refused socket has to be closed with a status code, and a thrown
      // AppError would try to write a JSON body to a connection the browser is expecting to
      // upgrade. The principal is anonymous for a deleted session and for a suspended tenant too.
      const principal = req.principal;
      if (principal.kind !== "participant") {
        socket.close(CLOSE_POLICY, "participant session required");
        return;
      }
      void new LiveVoiceSession(ctx, socket, {
        companyId: principal.companyId,
        sessionId: principal.sessionId,
      }).run();
    },
  );
}

interface Scope {
  companyId: string;
  sessionId: string;
}

/** The tenant's voice knobs, read once when the call opens. */
interface SessionOpts {
  captions: boolean;
  bargeIn: boolean;
  voice: string;
  speed: number;
}

/**
 * One live conversation.
 *
 * Holds the buffered audio of the utterance in progress (utterance mode) or the provider's
 * transcription socket (stream mode), the abort handle for the speech currently playing, and the
 * counters the spec asks to trace. Everything is per-socket; nothing is shared.
 */
class LiveVoiceSession {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private sessionBytes = 0;
  private busy = false;
  /**
   * Something said while a turn was still running.
   *
   * Dropping it would be wrong in the most ordinary case there is: the participant hears the
   * question, starts answering immediately, and the interviewer is still speaking. Barge-in means
   * exactly that is expected. It is held and answered as soon as the turn in flight ends.
   */
  private pending: Held | undefined;
  private closed = false;
  /**
   * Aborted when the socket closes or errors, and handed to the turn: a participant who hangs up
   * mid-turn must stop the model call in flight, not leave it to run to completion and be billed.
   */
  private readonly gone = new AbortController();
  /** Aborts the synthesis in flight. Replaced on every turn, called on barge-in. */
  private speaking: AbortController | undefined;
  private mode: HearingMode = "utterance";
  /** The provider's transcription socket, in stream mode. */
  private stt: SttStreamSession | undefined;
  /** Binary frames are dropped until the browser confirms it changed capture format. */
  private awaitingCapture = false;
  /** The provider said the participant stopped; a final transcript (or a failure) is owed. */
  private awaitingFinal = false;
  private speechStartedAt: number | undefined;
  private partialSeen = false;
  private opts: SessionOpts = { captions: true, bargeIn: true, voice: "alloy", speed: 1 };
  private interruptions = 0;
  private turns = 0;
  private firstWordMsTotal = 0;
  private firstWordSamples = 0;
  private firstPartialMsTotal = 0;
  private firstPartialSamples = 0;
  private streamFallbacks = 0;

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
    // Listeners first: the provider socket takes a moment to open, and a participant who hangs up
    // in that moment must not leave it open behind them.
    this.socket.on("close", () => {
      this.closed = true;
      this.gone.abort();
      this.speaking?.abort();
      this.stt?.close();
      void this.scoped(() => this.recordMetrics());
    });
    this.socket.on("error", () => {
      this.closed = true;
      this.gone.abort();
      this.speaking?.abort();
      this.stt?.close();
    });

    const settings = await this.scoped(() => this.settings());
    if (!settings.enabled) {
      this.send({ type: "unavailable", reason: "disabled", fallback: "recorded" });
      this.socket.close(CLOSE_POLICY, "live voice is turned off");
      return;
    }
    this.opts = settings;
    await this.scoped(() => this.openStream(settings));
    if (this.closed) {
      this.stt?.close();
      return;
    }
    this.send({
      type: "ready",
      captions: settings.captions,
      bargeIn: settings.bargeIn,
      mode: this.mode,
      ...(this.mode === "stream" ? { sampleRate: STT_STREAM_SAMPLE_RATE } : {}),
    });

    this.socket.on("message", (data: Buffer, isBinary: boolean) => {
      void this.scoped(() => this.onMessage(data, isBinary));
    });
  }

  /**
   * Opens the provider's streaming transcription when the tenant has an `stt_stream` route.
   *
   * Any failure here is a fallback, not an error: a bad key, a host that does not speak the
   * Realtime protocol, or a spent budget all leave the per-utterance path, which is what live voice
   * did before streaming existed and which still works.
   */
  private async openStream(settings: { endOfSpeechMs: number; language: string | undefined }): Promise<void> {
    try {
      const caller = await this.ctx.callers.forCompany(this.scope.companyId);
      const stt = await caller.transcribeStream(
        { companyId: this.scope.companyId, sessionId: this.scope.sessionId },
        {
          silenceMs: settings.endOfSpeechMs,
          ...(settings.language ? { language: settings.language } : {}),
        },
      );
      if (!stt) return;
      this.stt = stt;
      this.mode = "stream";
      void this.pump(stt);
    } catch (err) {
      this.streamFallbacks++;
      this.ctx.log.warn(
        { err, sessionId: this.scope.sessionId },
        "live voice: streaming transcription unavailable, transcribing per utterance",
      );
    }
  }

  private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
    if (this.closed) return;
    if (isBinary) {
      if (this.awaitingCapture) return;
      if (this.mode === "stream") this.stream(data);
      else this.collect(data);
      return;
    }
    const parsed = ClientFrame.safeParse(safeJson(data.toString("utf8")));
    if (!parsed.success) return;
    const frame = parsed.data;
    // Not re-checked here: awaiting a query before a `capture` or `cancel` frame is handled would
    // let the binary frames behind it overtake it. The checks sit where a turn is begun
    // (`takeTurn`), where audio is paid for (`onUtterance`) and where text is replayed.
    switch (frame.type) {
      case "start":
        // The opening question, spoken. No answer, so the engine asks its first thing.
        await this.takeTurn(undefined);
        return;
      case "speak_last":
        await this.speakLast();
        return;
      case "barge":
        this.barge();
        return;
      case "cancel":
        this.reset();
        return;
      case "utterance":
        if (this.mode === "utterance") await this.onUtterance();
        return;
      case "capture":
        if (frame.mode === this.mode) this.awaitingCapture = false;
        // Asked to stream, and this browser cannot capture PCM (no AudioWorklet): the rung below.
        else if (frame.mode === "utterance") await this.fallBackFromStream("client_capture");
        return;
      case "bye":
        this.socket.close(1000, "bye");
        return;
    }
  }

  /**
   * Stop talking immediately. This is the whole point of barge-in: a participant who starts
   * answering should not have to wait for the interviewer to finish a sentence.
   */
  private barge(): void {
    this.interruptions++;
    this.speaking?.abort();
    this.send({ type: "speech_end", interrupted: true });
  }

  /**
   * False, and the socket closed, once the session is deleted or its tenant suspended (S3, S8).
   * The door was checked when the connection opened; a conversation can outlive that decision.
   */
  private async stillAllowed(): Promise<boolean> {
    const session = await this.ctx.db.session.findUnique({
      where: { id: this.scope.sessionId },
      select: { status: true },
    });
    const active = await this.ctx.tenants.isActive(this.scope.companyId);
    if (session && session.status !== "deleted" && active) return true;
    this.closed = true;
    this.speaking?.abort();
    this.stt?.close();
    this.send({ type: "unavailable", reason: "disabled", fallback: "recorded" });
    this.socket.close(CLOSE_POLICY, "session no longer available");
    return false;
  }

  /**
   * Reads the most recent interviewer question aloud. No engine turn, so nothing is stored and the
   * turn lock is never taken: this is a replay of something the participant can already see.
   */
  private async speakLast(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const askedAt = Date.now();
    try {
      if (!(await this.stillAllowed())) return;
      const last = await this.ctx.db.message.findFirst({
        where: { sessionId: this.scope.sessionId, role: "assistant" },
        orderBy: { seq: "desc" },
        select: { content: true, widget: true },
      });
      if (!last) {
        // Nothing has been asked yet, so there is nothing to repeat; open the interview instead.
        this.busy = false;
        await this.takeTurn(undefined);
        return;
      }
      const widget = last.widget ? (last.widget as Widget) : undefined;
      const spoken = toSpokenTurn(last.content, widget);
      await this.speak(spoken.text, askedAt, spoken.shortened);
    } catch (err) {
      this.onProviderFailure(err, "speech");
    } finally {
      this.busy = false;
    }
  }

  /** Counts audio against the session's ceiling; false when the socket had to be closed. */
  private admit(data: Buffer, ceiling: number): boolean {
    this.sessionBytes += data.byteLength;
    if (this.sessionBytes > ceiling) {
      this.socket.close(CLOSE_TOO_BIG, "too much audio");
      this.closed = true;
      this.stt?.close();
      return false;
    }
    return true;
  }

  private collect(data: Buffer): void {
    if (!this.admit(data, MAX_SESSION_BYTES)) return;
    if (this.bytes + data.byteLength > MAX_UTTERANCE_BYTES) return; // drop the tail, keep the head
    this.chunks.push(data);
    this.bytes += data.byteLength;
  }

  /** Stream mode: PCM16 goes straight to the provider, nothing is buffered here. */
  private stream(data: Buffer): void {
    if (!this.admit(data, MAX_STREAM_SESSION_BYTES)) return;
    // An odd byte count would shift every later sample by half a sample: noise, not speech.
    const even = data.byteLength % 2 === 0 ? data : data.subarray(0, data.byteLength - 1);
    this.stt?.push(new Uint8Array(even.buffer, even.byteOffset, even.byteLength));
  }

  private reset(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }

  /**
   * Reads the provider's transcription events for as long as the session lasts.
   *
   * The final transcript is handled exactly like a transcribed utterance: captioned, then answered
   * as a normal turn, or held when a turn is already running.
   */
  private async pump(stt: SttStreamSession): Promise<void> {
    try {
      for await (const ev of stt.events) {
        if (this.closed) break;
        if (ev.type === "error" && ev.fatal) break;
        // Not awaited: a final transcript runs a whole turn, and the partial captions of whatever
        // the participant says next must keep flowing while it does.
        void this.scoped(() => this.onSttEvent(ev));
      }
    } catch (err) {
      this.ctx.log.warn({ err, sessionId: this.scope.sessionId }, "live voice: stt stream failed");
    }
    if (this.closed || this.stt !== stt) return;
    // The events ended without this side closing them: the provider went away mid-call.
    await this.scoped(() => this.fallBackFromStream("stt_stream_failed"));
  }

  private async onSttEvent(ev: SttStreamEvent): Promise<void> {
    switch (ev.type) {
      case "speech_started":
        this.speechStartedAt = Date.now();
        this.partialSeen = false;
        {
          // The provider hears the participant start talking over the interviewer: the same
          // barge-in the browser's own detector performs, from the other end. `barged` tells the
          // browser the server already did it, so it stops playback without a second `barge`.
          const barged = Boolean(this.speaking) && this.opts.bargeIn;
          if (barged) this.barge();
          this.send({ type: "speech_started", barged });
          return;
        }
      case "speech_stopped":
        this.awaitingFinal = true;
        this.send({ type: "speech_stopped" });
        return;
      case "partial":
        if (!this.partialSeen && this.speechStartedAt !== undefined) {
          this.partialSeen = true;
          this.firstPartialMsTotal += Date.now() - this.speechStartedAt;
          this.firstPartialSamples++;
        }
        if (this.opts.captions) this.send({ type: "caption_partial", text: ev.text });
        return;
      case "final":
        this.awaitingFinal = false;
        await this.onFinal(ev.text, ev.confidence);
        return;
      case "error":
        this.ctx.log.warn({ sessionId: this.scope.sessionId, message: ev.message }, "live voice: stt");
        // A turn the provider could not transcribe is a turn the participant has to repeat.
        if (this.awaitingFinal) {
          this.awaitingFinal = false;
          this.send({ type: "not_heard" });
        }
        return;
    }
  }

  /** Answers a final transcript from the stream, or holds it while a turn is running. */
  private async onFinal(raw: string, confidence: number | undefined): Promise<void> {
    const text = raw.trim();
    if (text.length === 0) {
      this.send({ type: "not_heard" });
      return;
    }
    if (this.opts.captions) {
      this.send({
        type: "caption_final",
        role: "user",
        text,
        ...(confidence === undefined ? {} : { confidence }),
      });
    }
    if (this.busy) {
      // Keep the most recent one, for the reason `onUtterance` gives.
      this.pending = { kind: "text", text };
      return;
    }
    await this.takeTurn({ content: text.slice(0, 8000), modality: "voice" as const });
  }

  /**
   * Streaming is over for this call: the provider's socket died, or the browser cannot capture PCM.
   * Per-utterance transcription is the rung below it, so the browser is told to capture that way;
   * with no transcription route there is nothing below it but typing.
   */
  private async fallBackFromStream(reason: "stt_stream_failed" | "client_capture"): Promise<void> {
    const stt = this.stt;
    this.stt = undefined;
    stt?.close();
    this.streamFallbacks++;
    if (await this.hasRoute("transcription")) {
      this.mode = "utterance";
      this.reset();
      // A browser that asked for utterance mode is already capturing that way; one the server
      // moved has PCM in flight, which must not be mistaken for the start of a recording.
      this.awaitingCapture = reason === "stt_stream_failed";
      this.send({ type: "mode", mode: "utterance", reason });
      return;
    }
    this.send({ type: "unavailable", reason, fallback: "text" });
  }

  /** Tenant route first, platform second, as the resolver reads them. */
  private async hasRoute(purpose: "transcription"): Promise<boolean> {
    const row = await this.ctx.db.route.findFirst({
      where: { purpose, OR: [{ companyId: this.scope.companyId }, { companyId: null }] },
      select: { id: true },
    });
    return row !== null;
  }

  /** Transcribe what was said, then take a turn on it. */
  private async onUtterance(): Promise<void> {
    const audio = Buffer.concat(this.chunks);
    this.reset();
    if (audio.byteLength === 0) return;
    if (this.busy) {
      // Keep the most recent one. If they said two things while the interviewer was talking, the
      // second is the one they meant; answering the first would put the conversation a turn behind.
      this.pending = { kind: "audio", audio };
      return;
    }

    this.busy = true;
    try {
      // Before the transcription, which is paid for, not only before the turn that follows it.
      if (!(await this.stillAllowed())) return;
      const caller = await this.ctx.callers.forCompany(this.scope.companyId);
      const transcript = await caller.transcribe(
        { companyId: this.scope.companyId, sessionId: this.scope.sessionId },
        {
          data: new Uint8Array(audio),
          mime: "audio/webm",
          filename: "utterance.webm",
          languages: speechLanguages(await this.ctx.attachments.languageFor(this.scope.sessionId)),
        },
      );
      const text = transcript.text.trim();
      if (text.length === 0) {
        // Silence, or a microphone picking up nothing. Say so rather than sending an empty answer,
        // which would make the interviewer ask a confused follow-up.
        this.send({ type: "not_heard" });
        return;
      }
      if (this.opts.captions) {
        this.send({
          type: "caption",
          role: "user",
          text,
          ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence }),
        });
      }
      await this.takeTurn({ content: text.slice(0, 8000), modality: "voice" as const }, true);
    } catch (err) {
      this.onProviderFailure(err, "transcription");
    } finally {
      this.busy = false;
      await this.drainPending();
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
    alreadyBusy = false,
  ): Promise<void> {
    if (!alreadyBusy) {
      if (this.busy) return;
      this.busy = true;
    }
    // Every turn passes here, whatever started it: a control frame, a streamed final from the
    // provider, or an utterance held back while the last turn finished.
    if (!(await this.stillAllowed())) {
      if (!alreadyBusy) this.busy = false;
      return;
    }
    const askedAt = Date.now();
    try {
      for await (const item of streamTurn(this.ctx, this.scope.sessionId, answer, {
        signal: this.gone.signal,
      })) {
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
          if (this.opts.captions) {
            this.send({ type: "caption", role: "assistant", text: data.message.content });
          }
          await this.speak(spoken.text, askedAt, spoken.shortened);
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
        await this.drainPending();
      }
    }
  }

  /** Answers whatever was said mid-turn, now that the turn is over. */
  private async drainPending(): Promise<void> {
    const held = this.pending;
    if (!held || this.closed) return;
    this.pending = undefined;
    if (held.kind === "text") {
      await this.takeTurn({ content: held.text.slice(0, 8000), modality: "voice" as const });
      return;
    }
    this.chunks.push(held.audio);
    this.bytes = held.audio.byteLength;
    await this.onUtterance();
  }

  /**
   * Synthesizes and streams the interviewer's voice.
   *
   * Falls back rather than failing: with no `tts` route the client is told to carry on with
   * captions only, which is the middle rung of the spec's real-time → recorded → text chain. The
   * interview continues either way — that is the requirement, "without losing the session".
   */
  private async speak(text: string, askedAt: number, shortened: boolean): Promise<void> {
    if (text.length === 0) return;
    const controller = new AbortController();
    this.speaking = controller;
    try {
      const caller = await this.ctx.callers.forCompany(this.scope.companyId);
      const out = await caller.speak(
        { companyId: this.scope.companyId, sessionId: this.scope.sessionId },
        { text, voice: this.opts.voice, speed: this.opts.speed, format: "opus" },
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
    if (err instanceof UnsupportedAudioError) {
      // The route exists but reads WAV only — the on-server Whisper (D-75) — and live voice sends
      // WebM. Recorded voice converts to WAV in the browser before uploading, so it does work, and
      // that is where the participant goes; telling them to type would give up a working voice.
      this.ctx.log.info(
        { sessionId: this.scope.sessionId },
        "live voice: route reads WAV only, using recorded",
      );
      this.send({ type: "unavailable", reason: "transcription_needs_wav", fallback: "recorded" });
      return;
    }
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

  /** The signals spec 09 asks to trace per session, written once at the end. */
  private async recordMetrics(): Promise<void> {
    if (this.turns === 0) return;
    const avg = (total: number, n: number): number | null => (n > 0 ? Math.round(total / n) : null);
    await this.ctx.db.sessionEvent
      .create({
        data: {
          companyId: this.scope.companyId,
          sessionId: this.scope.sessionId,
          seq: Date.now() % 2_147_483_647,
          type: "voice.live",
          payload: {
            turns: this.turns,
            interruptions: this.interruptions,
            avgFirstWordMs: avg(this.firstWordMsTotal, this.firstWordSamples),
            // Stream mode only: the participant starts talking to the first word of their caption.
            avgFirstPartialMs: avg(this.firstPartialMsTotal, this.firstPartialSamples),
            mode: this.mode,
            streamFallbacks: this.streamFallbacks,
            audioBytes: this.sessionBytes,
          },
        },
      })
      .catch(() => undefined);
  }

  private async settings(): Promise<
    SessionOpts & { enabled: boolean; endOfSpeechMs: number; language: string | undefined }
  > {
    const chain = [{ scope: "tenant" as const, scopeId: this.scope.companyId }];
    const [values, session] = await Promise.all([
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
      this.ctx.db.session.findUnique({
        where: { id: this.scope.sessionId },
        select: { template: { select: { language: true } } },
      }),
    ]);
    return {
      enabled: values["features.realtimeVoice"] as boolean,
      captions: values["voice.captions"] as boolean,
      bargeIn: values["voice.bargeIn"] as boolean,
      voice: values["voice.voiceName"] as string,
      speed: values["voice.speakingRate"] as number,
      endOfSpeechMs: values["voice.endOfSpeechMs"] as number,
      language: session?.template.language,
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
