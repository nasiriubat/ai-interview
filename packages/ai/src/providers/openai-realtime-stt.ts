import type { SttStreamEvent, SttStreamInput, SttStreamSession, Usage } from "@aidp/shared";
import { STT_STREAM_SAMPLE_RATE } from "@aidp/shared";
import { ProviderError, type RealtimeSocket, type RealtimeSocketFactory } from "./types.js";

/**
 * OpenAI Realtime transcription (FR-30a, D-77), checked against the platform documentation in
 * September 2026:
 *
 * - Connect: `wss://api.openai.com/v1/realtime?intent=transcription` with `Authorization: Bearer`.
 *   The generally-available interface needs no `OpenAI-Beta` header.
 * - Configure: one `session.update` whose `session.type` is `"transcription"`, with the format,
 *   model and turn detection under `session.audio.input`. The input format is
 *   `{ type: "audio/pcm", rate: 24000 }`; "only a 24kHz sample rate is supported".
 * - `gpt-live-transcribe` and `gpt-transcribe` take `languages: [..]`; the older models
 *   (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`) take a singular `language`. The
 *   API rejects a session that sends both, so exactly one is sent.
 * - Audio: `input_audio_buffer.append` with base64 PCM16. With `server_vad` the server commits
 *   each turn itself and reports `input_audio_buffer.speech_started` / `.speech_stopped`.
 * - Text: `conversation.item.input_audio_transcription.delta` (`delta`, per `item_id`) while the
 *   participant talks, `.completed` (`transcript`, `usage`) at the end of the turn, `.failed` when
 *   one turn could not be transcribed. Completions of different turns may arrive out of order, so
 *   partial text is kept per item.
 */

/** Models that take the plural `languages` hint rather than `language`. */
const PLURAL_LANGUAGE_MODELS = /^gpt-(live-)?transcribe(\b|-)/;

/** A session that has not confirmed its configuration by now is not going to. */
const CONFIGURE_TIMEOUT_MS = 10_000;

export interface RealtimeSttOptions {
  /** `https://api.openai.com/v1` or an OpenAI-compatible base; the scheme is switched to ws(s). */
  baseUrl: string;
  headers: Record<string, string>;
  socket: RealtimeSocketFactory;
}

export function realtimeTranscriptionUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/realtime`);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("intent", "transcription");
  return url.toString();
}

export function transcriptionSessionUpdate(model: string, input: SttStreamInput): Record<string, unknown> {
  const language = input.language?.trim().toLowerCase().slice(0, 2);
  const languageHint = language
    ? PLURAL_LANGUAGE_MODELS.test(model)
      ? { languages: [language] }
      : { language }
    : {};
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: STT_STREAM_SAMPLE_RATE },
          transcription: { model, ...languageHint },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: input.silenceMs ?? 700,
          },
        },
      },
    },
  };
}

/** Opens one transcription session and resolves when the provider has accepted its configuration. */
export function openRealtimeTranscription(
  opts: RealtimeSttOptions,
  model: string,
  input: SttStreamInput,
): Promise<SttStreamSession> {
  const headers = { ...opts.headers };
  delete headers["content-type"];
  const url = realtimeTranscriptionUrl(opts.baseUrl);

  return new Promise<SttStreamSession>((resolve, reject) => {
    let socket: RealtimeSocket;
    try {
      socket = opts.socket(url, headers);
    } catch (e) {
      reject(new ProviderError("Could not open the transcription socket", "network", true, e));
      return;
    }
    const queue = new EventQueue();
    const partials = new Map<string, string>();
    let configured = false;
    let closedByUs = false;
    const timer = setTimeout(() => {
      if (configured) return;
      fail(new ProviderError("Transcription session was not confirmed in time", "network", true));
    }, CONFIGURE_TIMEOUT_MS);

    const session: SttStreamSession = {
      push(pcm16) {
        if (!configured || queue.ended || pcm16.byteLength === 0) return;
        try {
          socket.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString("base64"),
            }),
          );
        } catch {
          // The socket is going away; its close handler ends the stream.
        }
      },
      events: queue,
      close() {
        if (closedByUs) return;
        closedByUs = true;
        clearTimeout(timer);
        queue.end();
        try {
          socket.close(1000, "done");
        } catch {
          // Already closed.
        }
      },
    };

    /** Before configuration a failure rejects the open; after it, it ends the event stream. */
    function fail(err: ProviderError): void {
      clearTimeout(timer);
      if (!configured) {
        configured = true; // settle once
        closedByUs = true;
        try {
          socket.close(1011, "failed");
        } catch {
          // Nothing to close.
        }
        reject(err);
        return;
      }
      queue.push({ type: "error", message: err.message, fatal: true });
      queue.end();
    }

    socket.on("open", () => {
      try {
        socket.send(JSON.stringify(transcriptionSessionUpdate(model, input)));
      } catch (e) {
        fail(new ProviderError("Could not configure the transcription session", "network", true, e));
      }
    });

    socket.on("message", (data) => {
      const event = parseEvent(data);
      if (!event) return;
      switch (event.type) {
        case "session.updated":
        case "transcription_session.updated":
          if (!configured) {
            configured = true;
            clearTimeout(timer);
            resolve(session);
          }
          return;
        case "error": {
          const message = errorMessage(event);
          if (!configured) {
            fail(new ProviderError(`Transcription session refused: ${message}`, errorCode(event), false));
            return;
          }
          // Most realtime errors are recoverable and the session stays open (per the reference).
          queue.push({ type: "error", message, fatal: false });
          return;
        }
        case "input_audio_buffer.speech_started":
          queue.push({ type: "speech_started" });
          return;
        case "input_audio_buffer.speech_stopped":
          queue.push({ type: "speech_stopped" });
          return;
        case "conversation.item.input_audio_transcription.delta": {
          const itemId = str(event.item_id) ?? "item";
          const text = (partials.get(itemId) ?? "") + (str(event.delta) ?? "");
          partials.set(itemId, text);
          queue.push({ type: "partial", itemId, text });
          return;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const itemId = str(event.item_id) ?? "item";
          partials.delete(itemId);
          const usage = toUsage(event.usage);
          queue.push({
            type: "final",
            itemId,
            text: str(event.transcript) ?? "",
            ...(usage.seconds === undefined ? {} : { durationSeconds: usage.seconds }),
            ...(usage.tokens ? { usage: usage.tokens } : {}),
          });
          return;
        }
        case "conversation.item.input_audio_transcription.failed": {
          const itemId = str(event.item_id) ?? "item";
          partials.delete(itemId);
          queue.push({ type: "error", message: errorMessage(event), fatal: false });
          return;
        }
        default:
          return;
      }
    });

    socket.on("error", (err) => {
      fail(new ProviderError(`Transcription socket error: ${err.message}`, "network", true, err));
    });

    socket.on("close", (code) => {
      clearTimeout(timer);
      if (closedByUs) {
        queue.end();
        return;
      }
      const auth = code === 1008 || code === 4001 || code === 4003;
      fail(new ProviderError(`Transcription socket closed (${code})`, auth ? "auth" : "network", !auth));
    });
  });
}

type Event = Record<string, unknown> & { type: string };

function parseEvent(data: unknown): Event | undefined {
  let text: string;
  if (typeof data === "string") text = data;
  else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
  else if (Array.isArray(data)) text = Buffer.concat(data as Uint8Array[]).toString("utf8");
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
  else return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as Event).type === "string")
      return parsed as Event;
  } catch {
    // Not JSON; not ours.
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function errorMessage(event: Event): string {
  const e = event.error as { message?: unknown; code?: unknown } | undefined;
  return str(e?.message) ?? str(e?.code) ?? "unknown error";
}

function errorCode(event: Event): ProviderError["code"] {
  const e = event.error as { type?: unknown; code?: unknown } | undefined;
  const code = `${str(e?.type) ?? ""} ${str(e?.code) ?? ""}`;
  if (/auth|api_key|permission/i.test(code)) return "auth";
  if (/model_not_found|not_found/i.test(code)) return "not_found";
  return "bad_request";
}

/** `usage` on a completed transcription is either token counts or a duration in seconds. */
function toUsage(raw: unknown): { tokens?: Usage; seconds?: number } {
  if (!raw || typeof raw !== "object") return {};
  const u = raw as { type?: unknown; input_tokens?: unknown; output_tokens?: unknown; seconds?: unknown };
  if (u.type === "duration" && typeof u.seconds === "number") return { seconds: u.seconds };
  if (typeof u.input_tokens === "number" || typeof u.output_tokens === "number") {
    return {
      tokens: {
        inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
      },
    };
  }
  return {};
}

/** An unbounded single-consumer queue that is also the async iterable the session exposes. */
class EventQueue implements AsyncIterable<SttStreamEvent> {
  private readonly items: SttStreamEvent[] = [];
  private waiting: ((r: IteratorResult<SttStreamEvent>) => void) | undefined;
  ended = false;

  push(event: SttStreamEvent): void {
    if (this.ended) return;
    const w = this.waiting;
    if (w) {
      this.waiting = undefined;
      w({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const w = this.waiting;
    this.waiting = undefined;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SttStreamEvent> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
