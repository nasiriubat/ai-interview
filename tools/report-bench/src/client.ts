import { SseParser } from "../../live-run/src/pure.js";
import { redact } from "./openrouter.js";

export interface TurnMessage {
  id: string;
  role: string;
  content: string;
  widget?: { type: string; options?: { key: string; label: string }[] } | null;
}

export interface TurnOutcome {
  status: number;
  message: TurnMessage | null;
  text: string;
  ended: boolean;
  error: { code: string; message: string } | null;
}

export interface Res<T> {
  status: number;
  body: T;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A thin client for the product's public HTTP API. `base` is the API root including `/api/v1`,
 * e.g. `http://127.0.0.1:4100/api/v1` or `https://aiscope.scholarbro.com/api/v1`.
 */
export class Client {
  constructor(
    readonly base: string,
    private readonly token = "",
  ) {}

  private headers(json: boolean): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // not JSON; keep the text
    }
    return { status: res.status, body: parsed as T };
  }

  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body);
    if (r.status < 200 || r.status >= 300)
      throw new Error(`${method} ${path} -> ${r.status}: ${redact(JSON.stringify(r.body)).slice(0, 400)}`);
    return r.body;
  }

  /** One streamed participant turn. `input` undefined sends the empty first-turn body. */
  async turn(path: string, input?: { content: string; modality: "text" }): Promise<TurnOutcome> {
    const out: TurnOutcome = { status: 0, message: null, text: "", ended: false, error: null };
    const res = await fetch(`${this.base}${path}`, {
      method: "POST",
      headers: this.headers(input !== undefined),
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text();
      try {
        out.error = (JSON.parse(text) as { error?: { code: string; message: string } }).error ?? {
          code: String(res.status),
          message: text.slice(0, 200),
        };
      } catch {
        out.error = { code: String(res.status), message: text.slice(0, 200) };
      }
      return out;
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        const data = ev.data as Record<string, unknown>;
        if (ev.event === "text") out.text += str(data.delta);
        else if (ev.event === "turn") {
          out.message = data.message as TurnMessage;
          out.ended = data.ended === true;
        } else if (ev.event === "error")
          out.error = { code: str(data.code) || "error", message: str(data.message) };
      }
    }
    return out;
  }
}

/** Mints the Auth.js session JWT for a local instance whose AUTH_SECRET is known (same as live-run). */
export async function mintStaffToken(email: string, authSecret: string): Promise<string> {
  const { encode } = await import("@auth/core/jwt");
  return encode({ token: { email }, secret: authSecret, salt: "authjs.session-token" });
}
