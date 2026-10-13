import { encode } from "@auth/core/jwt";
import { SseParser } from "./pure.js";
import { API_BASE, redact } from "./runtime.js";

export interface RequestRecord {
  method: string;
  path: string;
  status: number;
  ms: number;
  /** Which actor made it, for the scorecard's error table. */
  actor: string;
  note?: string;
}

/** Every HTTP request the harness makes to the product, for the 4xx/5xx and latency tables. */
export const requestLog: RequestRecord[] = [];

export interface ApiResult<T> {
  status: number;
  body: T;
  ms: number;
}

export interface TurnOutcome {
  status: number;
  text: string;
  message: TurnMessage | null;
  ended: boolean;
  progress: { areas: { key: string; name: string; status: string }[] } | null;
  spec: unknown;
  error: { code: string; message: string } | null;
  firstTokenMs: number | null;
  totalMs: number;
  /** Raw event names in order, to see whether anything unexpected arrived. */
  eventNames: string[];
}

export interface TurnMessage {
  id: string;
  seq: number;
  role: string;
  content: string;
  widget?: Widget | null;
  areaKey?: string | null;
}

export type Widget =
  | { type: "single_choice"; options: WidgetOption[] }
  | { type: "multi_choice"; options: WidgetOption[]; max?: number }
  | { type: "scale"; min: 1; max: 5; minLabel: string; maxLabel: string }
  | { type: "ranking"; options: WidgetOption[] }
  | { type: "yes_no"; followUpOnYes?: string; followUpOnNo?: string };

export interface WidgetOption {
  key: string;
  label: string;
  detail?: string;
}

export type WidgetResponse =
  | { type: "single_choice"; key?: string; other?: string }
  | { type: "multi_choice"; keys: string[]; other?: string }
  | { type: "scale"; value: number }
  | { type: "ranking"; keys: string[] }
  | { type: "yes_no"; value: boolean; other?: string };

export interface TurnInput {
  content: string;
  modality: "text" | "widget";
  widgetResponse?: WidgetResponse;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class Api {
  constructor(
    private readonly actor: string,
    private token: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  setToken(token: string): void {
    this.token = token;
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(json ? { "content-type": "application/json" } : {}),
      ...this.extraHeaders,
    };
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const started = Date.now();
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    requestLog.push({ method, path: path.split("?")[0] ?? path, status: res.status, ms, actor: this.actor });
    let parsed: unknown = text;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // not JSON (markdown export); keep the text
    }
    return { status: res.status, body: parsed as T, ms };
  }

  /** Like `call` but throws on a non-2xx, naming the route and the (redacted) error body. */
  async ok<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.call<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`${method} ${path} -> ${r.status}: ${redact(JSON.stringify(r.body)).slice(0, 500)}`);
    }
    return r.body;
  }

  /** Raw bytes, for the zip bundle export. */
  async bytes(path: string): Promise<{ status: number; data: Buffer; contentType: string }> {
    const started = Date.now();
    const res = await fetch(`${API_BASE}${path}`, { headers: this.headers(false) });
    const data = Buffer.from(await res.arrayBuffer());
    requestLog.push({
      method: "GET",
      path: path.split("?")[0] ?? path,
      status: res.status,
      ms: Date.now() - started,
      actor: this.actor,
    });
    return { status: res.status, data, contentType: res.headers.get("content-type") ?? "" };
  }

  /** One streamed turn. `input` undefined sends the empty first-turn body. */
  async turn(path: string, input?: TurnInput): Promise<TurnOutcome> {
    const started = Date.now();
    const out: TurnOutcome = {
      status: 0,
      text: "",
      message: null,
      ended: false,
      progress: null,
      spec: null,
      error: null,
      firstTokenMs: null,
      totalMs: 0,
      eventNames: [],
    };
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: this.headers(input !== undefined),
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text();
      out.totalMs = Date.now() - started;
      try {
        const e = (JSON.parse(text) as { error?: { code: string; message: string } }).error;
        out.error = e ?? { code: String(res.status), message: text.slice(0, 200) };
      } catch {
        out.error = { code: String(res.status), message: text.slice(0, 200) };
      }
      requestLog.push({ method: "POST", path, status: res.status, ms: out.totalMs, actor: this.actor });
      return out;
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        out.eventNames.push(ev.event);
        const data = ev.data as Record<string, unknown>;
        if (ev.event === "text") {
          out.firstTokenMs ??= Date.now() - started;
          out.text += str(data.delta);
        } else if (ev.event === "turn") {
          out.message = data.message as TurnMessage;
          out.ended = data.ended === true;
          out.progress = data.progress as TurnOutcome["progress"];
        } else if (ev.event === "spec") {
          out.spec = data.spec;
        } else if (ev.event === "error") {
          out.error = { code: str(data.code) || "error", message: str(data.message) };
        }
      }
    }
    out.totalMs = Date.now() - started;
    requestLog.push({
      method: "POST",
      path,
      status: res.status,
      ms: out.totalMs,
      actor: this.actor,
      ...(out.error ? { note: `sse error ${out.error.code}` } : {}),
    });
    return out;
  }
}

/** Mints the Auth.js session JWT the web app would hold; the same mechanism the API's tests use. */
export async function staffToken(email: string, authSecret: string): Promise<string> {
  return encode({ token: { email }, secret: authSecret, salt: "authjs.session-token" });
}
