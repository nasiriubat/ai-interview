import { ExtractionResultSchema, FactSchema, InterviewTemplateSchema, StateDeltaSchema } from "@aidp/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { minimalValue } from "../src/schema-gen.js";
import { startFakeProvider, type FakeProvider } from "../src/server.js";

const MARKER = "<<<TURN_META>>>";
let fake: FakeProvider;
let control: string;

beforeAll(async () => {
  fake = await startFakeProvider({
    // Fast by default: these tests are about shape, not time.
    behaviour: { latencyMs: 0, jitterMs: 0, charsPerSecond: 0, ttsFirstByteMs: 0 },
    env: {},
  });
  control = fake.url.replace(/\/v1$/, "/__control");
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  await fetch(`${control}/reset`, { method: "POST" });
  fake.setBehaviour({ latencyMs: 0, jitterMs: 0, charsPerSecond: 0, ttsFirstByteMs: 0 });
});

const focusMessage = (focus: string, system = "1. intake: Intake. Where work arrives. Covered when: x") => [
  { role: "system", content: system },
  { role: "user", content: `(Session)\n\n<engine_focus>\n${focus}\n</engine_focus>\n\nReply format: ...` },
];

async function streamTurn(focus: string, system?: string): Promise<{ text: string; events: number }> {
  const res = await fetch(`${fake.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-fast", stream: true, messages: focusMessage(focus, system) }),
  });
  expect(res.status).toBe(200);
  const raw = await res.text();
  let text = "";
  let events = 0;
  let usage = false;
  for (const block of raw.split("\n\n")) {
    if (!block.startsWith("data: ") || block === "data: [DONE]") continue;
    events++;
    const chunk = JSON.parse(block.slice(6)) as {
      choices?: { delta?: { content?: string } }[];
      usage?: unknown;
    };
    text += chunk.choices?.[0]?.delta?.content ?? "";
    if (chunk.usage) usage = true;
  }
  expect(usage).toBe(true);
  expect(raw.trimEnd().endsWith("data: [DONE]")).toBe(true);
  return { text, events };
}

function parseTurn(text: string): { message: string; meta: Record<string, unknown> } {
  const at = text.indexOf(MARKER);
  expect(at).toBeGreaterThan(0);
  return {
    message: text.slice(0, at).trim(),
    meta: JSON.parse(text.slice(at + MARKER.length)) as Record<string, unknown>,
  };
}

describe("interviewer turns", () => {
  it("opens an area and the metadata parses as a state delta", async () => {
    const { text } = await streamTurn(
      'Engine focus: open area "intake" with one natural question. Set areaKey to "intake".',
    );
    const { message, meta } = parseTurn(text);
    expect(message).toMatch(/intake/i);
    expect(meta.areaKey).toBe("intake");
    const delta = StateDeltaSchema.parse(meta.stateDelta);
    expect(delta.coverage.intake?.status).toBe("partial");
  });

  it("covers the area on the follow-up and the next turn can progress", async () => {
    const { text } = await streamTurn('Engine focus: stay on area "intake". Set areaKey to "intake".');
    const delta = StateDeltaSchema.parse(parseTurn(text).meta.stateDelta);
    expect(delta.coverage.intake?.status).toBe("covered");
  });

  it("asks the context question in its own words and records a default answer", async () => {
    const { text } = await streamTurn(
      'Engine focus: context question "team_size". Ask: How many people work on this? Say briefly why it matters: sizing. Record the answer in stateDelta.contextAnswers["team_size"]. Set areaKey to "context".',
    );
    const { message, meta } = parseTurn(text);
    expect(message).toBe("How many people work on this?");
    const delta = StateDeltaSchema.parse(meta.stateDelta);
    expect(delta.contextAnswers.team_size).toBe("scripted answer");
    expect(delta.decisions[0]?.key).toBe("team_size");
  });

  it("ends the interview on the summary turn", async () => {
    const { text } = await streamTurn(
      'Engine focus: thank the participant and give a short summary (under 120 words). Set areaKey to "summary" and endInterview to true.',
    );
    expect(parseTurn(text).meta.endInterview).toBe(true);
  });

  it("records numbered functional requirements when the prompt asks for a specification", async () => {
    const { text } = await streamTurn(
      'Engine focus: stay on area "functional". Set areaKey to "functional".',
      "Specification capture: this interview produces a specification.\n1. functional: Functional requirements. What it does. Covered when: listed",
    );
    const delta = StateDeltaSchema.parse(parseTurn(text).meta.stateDelta);
    const paths = delta.facts.filter((f) => f.kind === "spec_field").map((f) => f.path);
    expect(paths).toEqual(["FR-1", "FR-2"]);
  });

  it("streams in more than one event when paced", async () => {
    fake.setBehaviour({ charsPerSecond: 20_000 });
    const { events } = await streamTurn('Engine focus: stay on area "intake". Set areaKey to "intake".');
    expect(events).toBeGreaterThan(5);
  });
});

describe("structured outputs", () => {
  const ask = async (schema: z.ZodType, name = "result"): Promise<unknown> => {
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fake-structured",
        messages: [{ role: "user", content: "Quote: I retype orders.\nAnother line." }],
        response_format: {
          type: "json_schema",
          json_schema: {
            name,
            strict: true,
            schema: z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" }),
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: { message: { content: string } }[]; usage: unknown };
    expect(body.usage).toBeTruthy();
    return JSON.parse(body.choices[0]?.message.content ?? "null");
  };

  it("returns facts out of a conversation that the extraction schema accepts", async () => {
    const out = ExtractionResultSchema.parse(await ask(ExtractionResultSchema, "extraction"));
    expect(out.facts.map((f) => f.kind).sort()).toEqual(["pain_point", "task"]);
  });

  it("returns a value for an arbitrary schema, with required fields filled", async () => {
    const schema = z.object({
      findings: z.array(z.object({ type: z.enum(["a", "b"]), n: z.number().int().min(3) })),
      summary: z.string().min(12),
      nested: z.object({ ok: z.boolean(), tags: z.array(z.string()).min(1) }),
      maybe: z.string().nullable(),
    });
    expect(schema.parse(await ask(schema))).toBeTruthy();
  });

  it("draws diagrams into a specification, for the renderer to draw", async () => {
    const schema = z.object({
      title: z.string().default(""),
      sections: z.array(z.object({ key: z.string(), markdown: z.string() })).default([]),
      diagrams: z
        .array(z.object({ key: z.string(), title: z.string(), type: z.string(), mermaid: z.string() }))
        .default([]),
    });
    const out = schema.parse(await ask(schema, "specification"));
    expect(out.diagrams.map((d) => d.type)).toEqual(["context", "sequence", "entity"]);
    expect(out.diagrams[0]?.mermaid).toMatch(/^flowchart/);
  });

  it("minimalValue satisfies the platform's own state schemas", () => {
    for (const schema of [StateDeltaSchema, FactSchema, InterviewTemplateSchema]) {
      const json = z.toJSONSchema(schema, { target: "openapi-3.0", unrepresentable: "any" });
      expect(() => schema.parse(minimalValue(json))).not.toThrow();
    }
  });

  it("finds the schema in the prompt when response_format carries none", async () => {
    const schema = z.object({ answer: z.string().min(1) });
    const instruction = `Respond with a single JSON value only, matching this JSON schema exactly:\n${JSON.stringify(
      z.toJSONSchema(schema, { target: "openapi-3.0" }),
    )}`;
    const res = await fetch(`${fake.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "x",
        messages: [
          { role: "system", content: instruction },
          { role: "user", content: "hi" },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(schema.parse(JSON.parse(body.choices[0]?.message.content ?? ""))).toEqual({ answer: "scripted" });
  });
});

describe("other endpoints", () => {
  it("lists models with prices", async () => {
    const body = (await (await fetch(`${fake.url}/models`)).json()) as {
      data: { id: string; pricing: object }[];
    };
    expect(body.data.length).toBeGreaterThan(2);
    expect(body.data[0]?.pricing).toBeTruthy();
  });

  it("answers embeddings 404 like OpenRouter until told otherwise", async () => {
    const post = (): Promise<Response> =>
      fetch(`${fake.url}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "e", input: ["a", "b"] }),
      });
    expect((await post()).status).toBe(404);
    fake.setBehaviour({ embeddings: "ok" });
    const ok = (await (await post()).json()) as { data: { embedding: number[] }[] };
    expect(ok.data).toHaveLength(2);
    expect(ok.data[0]?.embedding).toHaveLength(1536);
  });

  it("transcribes with the configured text", async () => {
    fake.setBehaviour({ transcript: "hello there" });
    const form = new FormData();
    form.append("model", "m");
    form.append("file", new Blob([new Uint8Array(100)]), "a.webm");
    const res = await fetch(`${fake.url}/audio/transcriptions`, { method: "POST", body: form });
    expect(await res.json()).toMatchObject({ text: "hello there" });
  });

  it("streams synthesized audio", async () => {
    fake.setBehaviour({ ttsBytes: 6000 });
    const res = await fetch(`${fake.url}/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "t", input: "hello", response_format: "mp3" }),
    });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect((await res.arrayBuffer()).byteLength).toBe(6000);
  });

  it("keeps what is posted to the webhook sink and hands it back", async () => {
    const sink = `${fake.url.replace("/v1", "")}/__sink`;
    await fetch(sink, { method: "DELETE" });
    await fetch(`${sink}/ntfy`, { method: "POST", headers: { title: "backup.failed" }, body: "it failed" });
    const got = (await (await fetch(sink)).json()) as {
      received: { title: string; body: string; path: string }[];
    };
    expect(got.received).toHaveLength(1);
    expect(got.received[0]).toMatchObject({
      title: "backup.failed",
      body: "it failed",
      path: "/__sink/ntfy",
    });
  });

  it("404s an unknown route", async () => {
    expect((await fetch(`${fake.url}/nope`)).status).toBe(404);
  });
});

describe("failure injection through the control endpoint", () => {
  const chat = (): Promise<Response> =>
    fetch(`${fake.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", stream: true, messages: focusMessage('area "intake"') }),
    });
  const set = (patch: object): Promise<Response> =>
    fetch(control, { method: "POST", body: JSON.stringify(patch) });

  it("returns the configured error status at the configured rate", async () => {
    await set({ errorRate: 1, errorStatus: 503 });
    expect((await chat()).status).toBe(503);
    await set({ errorRate: 0 });
    expect((await chat()).status).toBe(200);
  });

  it("answers 429 with a Retry-After", async () => {
    await set({ rate429: 1 });
    const res = await chat();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("0");
  });

  it("hangs until the client gives up, and counts it", async () => {
    await set({ hangRate: 1 });
    const started = Date.now();
    await expect(
      fetch(`${fake.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "m", stream: true, messages: focusMessage('area "intake"') }),
        signal: AbortSignal.timeout(300),
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fake.stats().injected.hangs).toBe(1);
  });

  it("delays the first token", async () => {
    await set({ firstTokenMs: 250 });
    const started = Date.now();
    const res = await chat();
    await res.text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
  });

  it("ignores values of the wrong type and reports the state it holds", async () => {
    const res = await set({ errorRate: "high", nonsense: 1, latencyMs: 12 });
    const body = (await res.json()) as { behaviour: { errorRate: number; latencyMs: number } };
    expect(body.behaviour).toMatchObject({ errorRate: 0, latencyMs: 12 });
  });

  it("repeats the same failures for the same seed", async () => {
    await set({ errorRate: 0.5, seed: 7 });
    const first: number[] = [];
    for (let i = 0; i < 12; i++) first.push((await chat()).status);
    await set({ seed: 7 });
    const second: number[] = [];
    for (let i = 0; i < 12; i++) second.push((await chat()).status);
    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(2);
  });
});

describe("realtime transcription socket", () => {
  const open = (): Promise<{ ws: WebSocket; messages: Record<string, unknown>[] }> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`${fake.url.replace("http", "ws")}/realtime?intent=transcription`);
      const messages: Record<string, unknown>[] = [];
      ws.addEventListener("message", (e) =>
        messages.push(JSON.parse(String(e.data)) as Record<string, unknown>),
      );
      ws.addEventListener("open", () => {
        resolve({ ws, messages });
      });
      ws.addEventListener("error", () => {
        reject(new Error("socket error"));
      });
    });
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 3000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the socket");
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it("confirms the session and transcribes one utterance of audio", async () => {
    fake.setBehaviour({ transcript: "we retype every order", sttUtteranceMs: 100 });
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: "session.update", session: { type: "transcription" } }));
    await until(() => messages.some((m) => m.type === "session.updated"));
    const frame = Buffer.alloc(48 * 120).toString("base64"); // 120 ms of 24 kHz PCM16
    ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: frame }));
    await until(() =>
      messages.some((m) => m.type === "conversation.item.input_audio_transcription.completed"),
    );
    const types = messages.map((m) => m.type);
    expect(types).toContain("input_audio_buffer.speech_started");
    expect(types).toContain("input_audio_buffer.speech_stopped");
    expect(
      messages.find((m) => m.type === "conversation.item.input_audio_transcription.completed"),
    ).toMatchObject({
      transcript: "we retype every order",
    });
    expect(fake.stats().realtimeAudioBytes).toBe(48 * 120);
    ws.close();
  });

  it("refuses the session like a bad model name would", async () => {
    fake.setBehaviour({ realtime: "refuse" });
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: "session.update", session: {} }));
    await until(() => messages.some((m) => m.type === "error"));
    ws.close();
  });

  it("handles a frame larger than 64 KiB", async () => {
    fake.setBehaviour({ sttUtteranceMs: 100_000 });
    const { ws, messages } = await open();
    ws.send(JSON.stringify({ type: "session.update", session: {} }));
    await until(() => messages.some((m) => m.type === "session.updated"));
    ws.send(
      JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(100_000).toString("base64") }),
    );
    await until(() => fake.stats().realtimeAudioBytes === 100_000);
    ws.close();
  });
});
