import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type Crypto, type EgressGuard, MemoryEmail, MemoryJobPublisher, MemoryStorage } from "@aidp/core";
import { shippedTemplates, withTenantScope } from "@aidp/db";
import { encode } from "@auth/core/jwt";
import { PrismaClient } from "@prisma/client";
import { pino } from "pino";
import { buildApp, type App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { buildContext } from "../src/context.js";

export const TURN_MARKER = "<<<TURN_META>>>";

/** A fake OpenAI-compatible server: streams a scripted reply for chat, answers the models list. */
/** Non-streaming structured answers by json_schema name; used by the analysis passes. */
export type Completions = (schemaName: string, userContent: string) => unknown;

export function fakeModelServer(
  replies: () => string,
  completions?: Completions,
  /** What `/audio/transcriptions` returns, for recorded-voice tests (FR-30). */
  transcription?: () => { text: string; duration?: number } | Error,
): Promise<{ server: Server; url: string; requests: unknown[] }> {
  const requests: unknown[] = [];
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
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, requests });
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
export async function testWorld(
  modelUrl: string,
  env: Record<string, string> = {},
  /** A guard with a fake resolver, for the suites that exercise the egress policy. */
  overrides: { egress?: EgressGuard } = {},
): Promise<TestWorld> {
  const key = randomBytes(32).toString("base64");
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    PLATFORM_ENCRYPTION_KEY: key,
    AUTH_SECRET: TEST_AUTH_SECRET,
    DATABASE_URL: process.env.DATABASE_URL ?? "",
    LOG_LEVEL: "silent",
    // The fake model server lives on loopback over http, which the strict policy would refuse.
    // Permissive keeps the hard denials (metadata addresses); a suite that is about the policy
    // opts in with EGRESS_MODE=strict (D-83).
    EGRESS_MODE: "permissive",
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
  const ctx = buildContext({
    config,
    db: appDb,
    log: pino({ level: "silent" }),
    jobs,
    email,
    storage,
    ...(overrides.egress ? { egress: overrides.egress } : {}),
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
