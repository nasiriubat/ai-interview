// Shared by the full-stack drill scripts (tools/rehearsal/drill/*.mjs). Plain Node 22+, no dependencies:
// these run on the operator's machine against a stack started by tools/rehearsal/drill/stack.sh, and
// everything they do goes through Caddy over HTTPS exactly as a browser would.
//
// The drill stack uses Caddy's own CA, so certificate verification is switched off for this
// process only. Nothing here is shipped or imported by the product.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.removeAllListeners("warning");

export const BASE = (process.env.AIDP_BASE_URL ?? "https://aidp.localhost:18443").replace(/\/+$/, "");
export const MAILPIT = (process.env.AIDP_MAILPIT_URL ?? "http://127.0.0.1:18025").replace(/\/+$/, "");
export const FAKE = (process.env.AIDP_FAKE_URL ?? "http://127.0.0.1:14010").replace(/\/+$/, "");
export const OPERATOR_EMAIL = process.env.AIDP_OPERATOR_EMAIL ?? "operator@aidp.test";
export const ADMIN_EMAIL = process.env.AIDP_ADMIN_EMAIL ?? "admin@aidp.test";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);

/** A tiny cookie jar: enough for Auth.js and the participant cookie. */
export class Client {
  constructor(label, extraHeaders = {}) {
    this.label = label;
    this.jar = new Map();
    this.extraHeaders = extraHeaders;
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (/;\s*max-age=0/i.test(line) || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async fetch(path, init = {}) {
    const url = path.startsWith("http") ? path : `${BASE}${path}`;
    const headers = { ...this.extraHeaders, ...(init.headers ?? {}) };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    const res = await fetch(url, { redirect: "manual", ...init, headers });
    this.absorb(res);
    return res;
  }

  /** JSON request; returns { status, body, ms }. */
  async json(method, path, body, headers = {}) {
    const started = Date.now();
    const res = await this.fetch(path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, body: parsed, ms: Date.now() - started, headers: res.headers };
  }

  async ok(method, path, body, headers) {
    const r = await this.json(method, path, body, headers);
    if (r.status < 200 || r.status >= 300)
      throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r.body;
  }

  /** One streamed interview turn. Resolves with what a browser would have rendered. */
  async turn(path, input) {
    const started = Date.now();
    const out = {
      status: 0,
      text: "",
      message: null,
      ended: false,
      error: null,
      firstTokenMs: null,
      totalMs: 0,
      events: [],
    };
    const res = await this.fetch(path, {
      method: "POST",
      headers: input === undefined ? {} : { "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    out.status = res.status;
    if (!res.ok || !res.body) {
      const text = await res.text();
      out.totalMs = Date.now() - started;
      try {
        out.error = JSON.parse(text).error ?? { code: String(res.status), message: text.slice(0, 200) };
      } catch {
        out.error = { code: String(res.status), message: text.slice(0, 200) };
      }
      return out;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let at;
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let event = "message";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        let parsed = {};
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          // ignore
        }
        out.events.push(event);
        if (event === "text") {
          out.firstTokenMs ??= Date.now() - started;
          out.text += parsed.delta ?? "";
        } else if (event === "turn") {
          out.message = parsed.message ?? null;
          out.ended = parsed.ended === true;
        } else if (event === "error") {
          out.error = { code: parsed.code ?? "error", message: parsed.message ?? "" };
        }
      }
    }
    out.totalMs = Date.now() - started;
    return out;
  }
}

/** The newest mail to `email` that arrived after `since` (ms), polled from the mail catcher. */
export async function mailTo(email, since, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${MAILPIT}/api/v1/messages?limit=50`);
    const list = await res.json();
    const hit = (list.messages ?? []).find(
      (m) =>
        m.To?.some((t) => t.Address.toLowerCase() === email.toLowerCase()) && Date.parse(m.Created) >= since,
    );
    if (hit) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json();
      return { id: hit.ID, subject: hit.Subject, text: full.Text ?? "", html: full.HTML ?? "" };
    }
    if (Date.now() > deadline) throw new Error(`no mail for ${email} within ${timeoutMs} ms`);
    await sleep(500);
  }
}

/** Signs a staff member in through the real magic-link flow and returns a client holding the session. */
export async function signIn(email, label = email) {
  const client = new Client(label);
  const since = Date.now() - 2000;
  const csrf = await (await client.fetch("/api/auth/csrf")).json();
  const form = new URLSearchParams({ csrfToken: csrf.csrfToken, email, callbackUrl: `${BASE}/` });
  const sent = await client.fetch("/api/auth/signin/nodemailer", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (sent.status >= 400) throw new Error(`sign-in request answered ${sent.status}`);
  const mail = await mailTo(email, since);
  const found = /https?:\/\/[^\s"'<>]+\/api\/auth\/callback\/[a-z]+[^\s"'<>]*/.exec(mail.text || mail.html);
  if (!found) throw new Error("the sign-in mail carries no link");
  // The link names the public hostname without a port; a drill listens on another one.
  const link = new URL(found[0].replace(/&amp;/g, "&"));
  const target = `${BASE}${link.pathname}${link.search}`;
  let res = await client.fetch(target);
  for (let hop = 0; hop < 4 && res.status >= 300 && res.status < 400; hop++) {
    const next = res.headers.get("location") ?? "/";
    res = await client.fetch(next.startsWith("http") ? next.replace(/^https?:\/\/[^/]+/, BASE) : next);
  }
  const session = await (await client.fetch("/api/auth/session")).json();
  if (!session?.user?.email)
    throw new Error(`signed in, but the session is empty: ${JSON.stringify(session)}`);
  return client;
}

/** staff API through the web proxy, as the admin screens call it. */
export const staff = (client, method, path, body, headers) =>
  client.ok(method, `/api/staff${path}`, body, headers);

export async function fakeControl(patch) {
  const res = await fetch(`${FAKE}/__control`, { method: "POST", body: JSON.stringify(patch ?? {}) });
  return res.json();
}
export async function fakeReset() {
  const res = await fetch(`${FAKE}/__control/reset`, { method: "POST" });
  return res.json();
}
export async function fakeStats() {
  return (await fetch(`${FAKE}/__control`)).json();
}
export async function sinkReceived() {
  return (await (await fetch(`${FAKE}/__sink`)).json()).received;
}
export async function sinkClear() {
  await fetch(`${FAKE}/__sink`, { method: "DELETE" });
}

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}
