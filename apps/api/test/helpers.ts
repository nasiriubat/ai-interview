import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SpeechRunner, type LanguageHint, type SpeechResult, type SpeechToTextEngine } from "@aidp/ai";
import {
  type Crypto,
  MemoryAlerts,
  MemoryEmail,
  MemoryJobAdmin,
  MemoryJobPublisher,
  MemoryStorage,
} from "@aidp/core";
import { shippedTemplates, withTenantScope } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { WebSocketServer } from "ws";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/context.js";

export const TURN_MARKER = "<<<TURN_META>>>";

/**
 * The on-server Whisper engine (D-75), in memory. Every test world gets one, so no suite can load
 * onnxruntime or download a model by routing to a `local` provider.
 */
export class FakeSpeechEngine implements SpeechToTextEngine {
  text = "We print the order and type it in again.";
  readonly calls: { model: string; seconds: number; hint: LanguageHint }[] = [];
  load(): Promise<void> {
    return Promise.resolve();
  }
  async transcribe(model: string, audio: Float32Array, hint: LanguageHint): Promise<SpeechResult> {
    this.calls.push({ model, seconds: audio.length / 16000, hint });
    return { text: this.text };
  }
  reset(): Promise<void> {
    return Promise.resolve();
  }
}

/** A fake OpenAI-compatible server: streams a scripted reply for chat, answers the models list. */
/** Non-streaming structured answers by json_schema name; used by the analysis passes. */
export type Completions = (schemaName: string, userContent: string) => unknown;

/**
 * How the fake Realtime transcription endpoint behaves for the next connection (FR-30a, D-77):
 *
 * - `transcript`: accepts the session, and answers each burst of appended audio with
 *   speech_started, two deltas, speech_stopped and a completion carrying `text`.
 * - `refuse`: answers the session.update with an error event, as a bad key or model would.
 * - `drop`: accepts the session, then closes the socket when audio first arrives.
 */
export type FakeRealtime = { kind: "transcript"; text: string } | { kind: "refuse" } | { kind: "drop" };

/** What the fake Realtime endpoint saw, for assertions. */
export interface RealtimeLog {
  connections: { url: string; authorization: string | undefined }[];
  sessionUpdates: unknown[];
  appendedBytes: number;
}

export function fakeModelServer(
  replies: () => string,
  completions?: Completions,
  /** What `/audio/transcriptions` returns, for recorded-voice tests (FR-30). */
  transcription?: () => { text: string; duration?: number } | Error,
  /** How `/realtime?intent=transcription` behaves, for streaming live-voice tests. */
  realtime?: () => FakeRealtime,
): Promise<{ server: Server; url: string; requests: unknown[]; realtime: RealtimeLog }> {
  const requests: unknown[] = [];
  const log: RealtimeLog = { connections: [], sessionUpdates: [], appendedBytes: 0 };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        // Multipart, so the body is not JSON and must be answered before the parse below.
        if (req.url?.endsWith("/audio/transcriptions")) {
          requests.push({ transcription: true });
          const out = transcription?.() ?? { text: "This is what I said out loud." };
          if (out instanceof Error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: { message: out.message } }));
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(out));
          return;
        }
        if (req.url?.endsWith("/models")) {
          // A key the tests call bad is refused the way OpenAI refuses one.
          if (req.headers.authorization?.startsWith("Bearer sk-bad")) {
            res.statusCode = 401;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }),
            );
            return;
          }
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              data: [
                { id: "fake-model", name: "Fake", pricing: { prompt: "0.000001", completion: "0.000002" } },
              ],
            }),
          );
          return;
        }
        const parsed = JSON.parse(body) as {
          stream?: boolean;
          response_format?: { json_schema?: { name?: string } };
          messages?: { content: string }[];
        };
        requests.push(parsed);
        if (!parsed.stream) {
          const name = parsed.response_format?.json_schema?.name ?? "";
          const content = completions
            ? JSON.stringify(completions(name, parsed.messages?.at(-1)?.content ?? ""))
            : "{}";
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content }, finish_reason: "stop" }],
              usage: { prompt_tokens: 300, completion_tokens: 120 },
            }),
          );
          return;
        }
        const text = replies();
        res.setHeader("content-type", "text/event-stream");
        for (let i = 0; i < text.length; i += 9) {
          res.write(
            `data: ${JSON.stringify({ model: "fake-model", choices: [{ delta: { content: text.slice(i, i + 9) } }] })}\n\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 60 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/v1/realtime")) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        log.connections.push({ url: req.url ?? "", authorization: req.headers.authorization });
        const behaviour = realtime?.() ?? { kind: "transcript", text: "This is what I said out loud." };
        let item = 0;
        let speaking = false;
        const emit = (event: Record<string, unknown>): void => {
          ws.send(JSON.stringify(event));
        };
        ws.on("message", (data: Buffer) => {
          const msg = JSON.parse(data.toString("utf8")) as {
            type: string;
            audio?: string;
            session?: unknown;
          };
          if (msg.type === "session.update") {
            log.sessionUpdates.push(msg.session);
            if (behaviour.kind === "refuse") {
              emit({
                type: "error",
                error: { type: "invalid_request_error", code: "model_not_found", message: "no such model" },
              });
              return;
            }
            emit({ type: "session.updated", session: msg.session });
            return;
          }
          if (msg.type !== "input_audio_buffer.append") return;
          log.appendedBytes += Buffer.from(msg.audio ?? "", "base64").byteLength;
          if (behaviour.kind === "drop") {
            ws.close(1011, "server error");
            return;
          }
          if (behaviour.kind !== "transcript" || speaking) return;
          // One burst of audio is one utterance: VAD start, words while talking, VAD stop, final.
          speaking = true;
          const id = `item_${++item}`;
          const words = behaviour.text.split(" ");
          const half = Math.ceil(words.length / 2);
          setTimeout(() => {
            emit({ type: "input_audio_buffer.speech_started", item_id: id, audio_start_ms: 0 });
            emit({
              type: "conversation.item.input_audio_transcription.delta",
              item_id: id,
              delta: words.slice(0, half).join(" "),
            });
            emit({
              type: "conversation.item.input_audio_transcription.delta",
              item_id: id,
              delta: ` ${words.slice(half).join(" ")}`,
            });
            emit({ type: "input_audio_buffer.speech_stopped", item_id: id, audio_end_ms: 900 });
            emit({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: id,
              transcript: behaviour.text,
              usage: { type: "tokens", input_tokens: 20, output_tokens: 8, total_tokens: 28 },
            });
            speaking = false;
          }, 20);
        });
      });
    });
    server.on("close", () => {
      wss.close();
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests, realtime: log });
    });
  });
}

export interface TestWorld {
  app: App;
  ctx: ReturnType<typeof buildContext>;
  db: PrismaClient;
  email: MemoryEmail;
  jobs: MemoryJobPublisher;
  storage: MemoryStorage;
  speech: FakeSpeechEngine;
  /** What the application raised: budget notices, dead letters (D-90). */
  alerts: MemoryAlerts;
  /** The queue's dead letters; seed one with `jobAdmin.addDead` (D-92). */
  jobAdmin: MemoryJobAdmin;
  crypto: Crypto;
  companyId: string;
  adminToken: string;
  adminEmail: string;
  operatorToken: string;
  templateId: string;
  close: () => Promise<void>;
}

const APP_ROLE_PASSWORD = "test-app-role";

/** A client connected as the unprivileged `app_api` role, with the tenant scope applied. */
async function appRoleClient(owner: PrismaClient): Promise<PrismaClient> {
  const url = process.env.DATABASE_URL;
  if (!url) return owner;
  try {
    await owner.$executeRawUnsafe(`ALTER ROLE app_api WITH LOGIN PASSWORD '${APP_ROLE_PASSWORD}'`);
    const asApp = new URL(url);
    asApp.username = "app_api";
    asApp.password = APP_ROLE_PASSWORD;
    const client = new PrismaClient({ datasources: { db: { url: asApp.toString() } } });
    await client.$queryRawUnsafe("SELECT 1");
    return withTenantScope(client) as unknown as PrismaClient;
  } catch {
    return owner;
  }
}

export const TEST_AUTH_SECRET = "test-secret-test-secret-test-secret";

/** `env` overrides land on top of the defaults, so a suite can pick its own rate-limit ceilings. */
export async function testWorld(modelUrl: string, env: Record<string, string> = {}): Promise<TestWorld> {
  const key = randomBytes(32).toString("base64");
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    PLATFORM_ENCRYPTION_KEY: key,
    AUTH_SECRET: TEST_AUTH_SECRET,
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    LOG_LEVEL: "silent",
    ...env,
  });
  const db = new PrismaClient();
  // The application under test connects the way production does: as `app_api`, which owns nothing
  // and has no BYPASSRLS, so every one of these tests is also a row-level-security conformance
  // test. Setup and assertions keep the owner client. A database where the role cannot be given a
  // login falls back to the owner, so the suite still runs (it just stops proving the fence).
  const appDb = await appRoleClient(db);
  const email = new MemoryEmail();
  const jobs = new MemoryJobPublisher();
  // Uploads stay in memory: a test that writes to a real directory has to clean it up, and the
  // two adapters are held to one contract by packages/core/test/storage.test.ts.
  const storage = new MemoryStorage();
  const speech = new FakeSpeechEngine();
  const alerts = new MemoryAlerts();
  const jobAdmin = new MemoryJobAdmin();
  const ctx = buildContext({
    config,
    db: appDb,
    log: pino({ level: "silent" }),
    jobs,
    email,
    storage,
    speech: new SpeechRunner(speech),
    alerts,
    jobAdmin,
  });
  const app = await buildApp(ctx);
  await app.ready();

  const suffix = Date.now().toString(36);
  const company = await db.company.create({ data: { name: `Test ${suffix}`, monthlyBudgetCents: 100_000 } });
  await db.budget.create({
    data: {
      companyId: company.id,
      scope: "tenant",
      scopeId: company.id,
      limitCents: 100_000,
      period: "month",
    },
  });
  await db.user.create({ data: { companyId: company.id, email: `admin-${suffix}@test.io`, role: "admin" } });
  const opCompany = await db.company.create({ data: { name: `Platform ${suffix}` } });
  await db.user.create({
    data: { companyId: opCompany.id, email: `op-${suffix}@test.io`, role: "platform_operator" },
  });

  const t = shippedTemplates()[0]!;
  const template = await db.interviewTemplate.create({
    data: {
      companyId: company.id,
      key: t.key,
      version: 1,
      name: t.name,
      objective: t.objective,
      privacyMode: t.privacyMode,
      participantFields: t.participantFields,
      coverageAreas: t.coverageAreas,
      aiInstructions: t.aiInstructions,
      adaptivity: t.adaptivity,
      widgetPolicy: t.widgetPolicy,
      outputs: t.outputs,
      analysisEnabled: true,
      status: "published",
    },
  });

  const provider = await db.provider.create({
    data: {
      companyId: company.id,
      kind: "openai_compatible",
      name: "fake",
      baseUrl: modelUrl,
      apiKeyEnc: ctx.crypto.encrypt("k"),
      headers: {},
    },
  });
  await db.modelPrice.create({
    data: {
      providerId: provider.id,
      model: "fake-model",
      inputPerMtok: 1,
      cachedInputPerMtok: 0.1,
      outputPerMtok: 2,
      source: "admin",
    },
  });
  for (const purpose of [
    "interview_turn",
    "resume_summary",
    "extraction",
    "clustering",
    "analysis_report",
    "file_ingest",
    "vision_ingest",
    "transcription",
  ]) {
    await db.route.create({
      data: {
        companyId: company.id,
        purpose,
        providerId: provider.id,
        model: "fake-model",
        maxOutputTokens: 800,
      },
    });
  }

  const token = (e: string) =>
    encode({ token: { email: e }, secret: config.AUTH_SECRET, salt: "authjs.session-token" });
  return {
    app,
    ctx,
    db,
    email,
    jobs,
    storage,
    speech,
    alerts,
    jobAdmin,
    crypto: ctx.crypto,
    companyId: company.id,
    adminToken: await token(`admin-${suffix}@test.io`),
    adminEmail: `admin-${suffix}@test.io`,
    operatorToken: await token(`op-${suffix}@test.io`),
    templateId: template.id,
    close: async () => {
      await app.close();
      await db.$disconnect();
    },
  };
}

/** Parses an SSE body into events. */
export function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const event = /event: (.+)/.exec(block)?.[1] ?? "message";
      const data = /data: (.+)/.exec(block)?.[1] ?? "null";
      return { event, data: JSON.parse(data) };
    });
}
