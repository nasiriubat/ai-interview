/*
 * Diagram rendering port (D-210, FR-23): Mermaid source in, an image out, by way of Kroki's Mermaid
 * renderer on the private network (`kroki-mermaid`, called directly: it answers `<base>/mermaid/svg`
 * as Kroki's gateway does, without the gateway's 3 GB Java image).
 *
 * The URL comes from the deployment's environment (`KROKI_URL`) and never from a tenant setting,
 * and the `fetch` it is given is the egress-guarded one (`EgressGuard.fetchFor("platform")`), so
 * the only host this can reach is the one the operator named and allow-listed. Kroki answers a
 * source it cannot parse with HTTP 400 and the parser's message; that is a *syntax* error, which
 * the owner can fix, and is told apart from the service being down, which they cannot.
 */

export type DiagramFormat = "svg" | "png";

export interface KrokiPort {
  /** Renders Mermaid source. Throws {@link KrokiSyntaxError} or {@link KrokiUnavailableError}. */
  render(source: string, format: DiagramFormat): Promise<Buffer>;
}

/** The renderer understood the request and the diagram is not valid Mermaid. */
export class KrokiSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrokiSyntaxError";
  }
}

/** The renderer could not be asked, did not answer in time, or answered with something unusable. */
export class KrokiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrokiUnavailableError";
  }
}

export interface HttpKrokiOptions {
  /** Base URL of the renderer, such as `http://kroki-mermaid:8002` (or a full Kroki, `http://kroki:8000`). */
  baseUrl: string;
  /** The egress-guarded fetch. Required: there is no default, by design. */
  fetch: typeof fetch;
  /** One render's budget in milliseconds. Default 15 000. */
  timeoutMs?: number;
  /** Largest image accepted back, in bytes. Default 4 MB. */
  maxBytes?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class HttpKroki implements KrokiPort {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: HttpKrokiOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  }

  async render(source: string, format: DiagramFormat): Promise<Buffer> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/mermaid/${format}`, {
        method: "POST",
        headers: {
          "content-type": "text/plain; charset=utf-8",
          accept: format === "png" ? "image/png" : "image/svg+xml",
        },
        body: source,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new KrokiUnavailableError(e instanceof Error ? e.message : "The diagram renderer is unreachable");
    }
    if (res.status === 400) {
      const text = (await readCapped(res, 4_000).catch(() => Buffer.alloc(0))).toString("utf8").trim();
      throw new KrokiSyntaxError(firstLines(errorMessage(text)) || "The diagram is not valid Mermaid");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new KrokiUnavailableError(`The diagram renderer answered ${res.status}`);
    }
    let body: Buffer;
    try {
      body = await readCapped(res, this.maxBytes);
    } catch (e) {
      throw new KrokiUnavailableError(e instanceof Error ? e.message : "The renderer's answer was unusable");
    }
    // A reachable service that answers something else (a proxy's error page, a captive portal) must
    // not end up embedded in a document as if it were a picture.
    if (format === "png" && !body.subarray(0, 8).equals(PNG_SIGNATURE))
      throw new KrokiUnavailableError("The renderer did not return a PNG image");
    if (format === "svg" && !/<svg[\s>]/i.test(body.subarray(0, 2_000).toString("utf8")))
      throw new KrokiUnavailableError("The renderer did not return an SVG image");
    return body;
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let seen = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The renderer's answer is larger than the limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The Mermaid renderer answers `{"error":{"message":…}}`; Kroki's gateway answers plain text. */
function errorMessage(text: string): string {
  if (!text.startsWith("{")) return text;
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    return typeof message === "string" ? message : text;
  } catch {
    return text;
  }
}

/** Kroki's 400 body repeats the parser's whole message; the first lines say what is wrong. */
function firstLines(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(" ")
    .slice(0, 300);
}

/**
 * The first lines of a diagram's source as the renderer is given them: the export's own theme and
 * label settings in front, so labels are drawn as SVG text (HTML labels are blank boxes once the
 * image leaves a browser). Callers have run `checkMermaidSource`, which refuses directives, so this
 * is the only one in the source.
 */
export function withExportTheme(source: string): string {
  return `%%{init: {"theme":"neutral","flowchart":{"htmlLabels":false},"securityLevel":"strict"}}%%\n${source.trim()}\n`;
}

/** A 1x1 transparent PNG, the smallest valid image the fake can hand back. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * In-memory renderer for tests: accepts any source whose first word is a diagram type, answers a
 * small valid image, and lets a test make it fail the two ways the real one does.
 */
export class FakeKroki implements KrokiPort {
  readonly calls: { source: string; format: DiagramFormat }[] = [];
  /** When set, every call fails this way. */
  failWith: "unavailable" | "syntax" | null = null;
  /** Sources containing this text are reported as syntax errors. */
  rejectContaining: string | null = null;
  /** Milliseconds each call takes, for deadline tests. */
  delayMs = 0;

  async render(source: string, format: DiagramFormat): Promise<Buffer> {
    this.calls.push({ source, format });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.failWith === "unavailable") throw new KrokiUnavailableError("fake renderer is down");
    if (this.failWith === "syntax") throw new KrokiSyntaxError("Parse error on line 2");
    if (this.rejectContaining && source.includes(this.rejectContaining))
      throw new KrokiSyntaxError(`Parse error: unexpected ${this.rejectContaining}`);
    if (format === "svg")
      return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    return TINY_PNG;
  }
}
