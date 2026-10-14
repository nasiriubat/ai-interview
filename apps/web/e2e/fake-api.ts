import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import * as f from "./fixtures";

/**
 * A tiny stand-in for the API (docs/spec/16 and 17), for the accessibility pass and nothing else.
 *
 * It answers the reads every page makes with fixtures and answers a write with a plain success, so
 * a page can be rendered and looked at without a database, a model or a mail server. It does no
 * authentication beyond requiring that a request names a credential, and it remembers every path
 * it had no answer for (`GET /__misses`), so a page that asks for something new shows up as a gap
 * in the fixtures rather than as a silently empty screen.
 */

type Handler = (url: URL, req: IncomingMessage) => { status?: number; body: unknown } | undefined;

const page = <K extends string, T>(key: K, rows: T[]) => ({
  [key]: rows,
  total: rows.length,
  limit: 25,
  offset: 0,
});

const READS: [RegExp, Handler][] = [
  [/^\/me$/, (_u, req) => ({ body: f.me(roleOf(req)) })],
  [/^\/health\/ready$/, () => ({ body: { ok: true } })],
  [
    /^\/onboarding$/,
    () => ({
      body: {
        steps: [
          { key: "provider", done: true },
          { key: "template", done: true },
          { key: "campaign", done: false },
          { key: "invite", done: false },
        ],
        done: 2,
        total: 4,
        complete: false,
        dismissed: false,
        next: "campaign",
      },
    }),
  ],
  [
    /^\/stats$/,
    () => ({
      body: {
        participation: {
          campaigns: { open: 2, closed: 1 },
          sessions: { completed: 11, active: 4 },
          invited: 24,
        },
        ai: {
          month: {
            costCents: 12500,
            calls: 880,
            inputTokens: 1_200_000,
            outputTokens: 210_000,
            cacheHitRate: 0.62,
            avgLatencyMs: 2100,
            byStatus: { ok: 870, error: 10 },
          },
          budget: { limitCents: 50000, period: "month" },
        },
      },
    }),
  ],
  [
    /^\/spend$/,
    () => ({
      body: {
        rows: [
          { key: "2026-10-12", costCents: 4100, calls: 300, tokens: 400000 },
          { key: "2026-10-13", costCents: 8400, calls: 580, tokens: 810000 },
          { key: "camp1", costCents: 8600, calls: 600, tokens: 900000 },
        ],
        budget: { limitCents: 50000, spentCents: 12500 },
      },
    }),
  ],
  [/^\/campaigns$/, () => ({ body: page("campaigns", [f.campaign]) })],
  [
    /^\/campaigns\/[^/]+$/,
    () => ({ body: { campaign: f.campaign, link: f.campaign.link, stats: f.campaign.stats } }),
  ],
  [/^\/campaigns\/[^/]+\/invitations$/, () => ({ body: { invitations: f.invitations } })],
  [/^\/campaigns\/[^/]+\/sessions$/, () => ({ body: page("sessions", f.sessions) })],
  [/^\/campaigns\/[^/]+\/analyses$/, () => ({ body: page("analyses", [f.analysis]) })],
  [
    /^\/analyses\/[^/]+$/,
    () => ({ body: { analysis: f.analysis, opportunities: f.analysisDetail.opportunities, report: null } }),
  ],
  [
    /^\/sessions\/[^/]+$/,
    () => ({
      body: {
        session: {
          id: "sess0001abcdef",
          status: "completed",
          campaignId: "camp1",
          templateKey: f.template.key,
          messages: [],
          flagged: false,
          createdAt: "2026-10-10T08:00:00.000Z",
          updatedAt: "2026-10-14T09:30:00.000Z",
        },
      },
    }),
  ],
  [/^\/sessions\/[^/]+\/events$/, () => ({ body: { events: [] } })],
  [/^\/templates$/, () => ({ body: page("templates", f.templateList) })],
  [/^\/templates\/[^/]+$/, () => ({ body: f.template })],
  [
    /^\/templates\/[^/]+\/versions$/,
    () => ({
      body: {
        versions: [
          {
            id: "tpl1",
            version: 3,
            status: "published",
            createdAt: "2026-10-14T09:30:00.000Z",
            createdBy: { id: "u1", name: "Ada Admin", email: "ada@acme.test" },
            changedFields: ["objective"],
            campaigns: 1,
            latest: true,
          },
          {
            id: "tpl1b",
            version: 2,
            status: "archived",
            createdAt: "2026-10-10T08:00:00.000Z",
            createdBy: null,
            changedFields: [],
            campaigns: 0,
            latest: false,
          },
        ],
      },
    }),
  ],
  [
    /^\/templates\/[^/]+\/diff-shipped$/,
    () => ({ body: { shipped: f.template, current: f.template, changedFields: [] } }),
  ],
  [/^\/requirements$/, () => ({ body: page("sessions", [f.requirementsItem]) })],
  [
    /^\/settings$/,
    () => ({
      body: {
        values: { "campaign.consentText": "Our own consent words." },
        catalog: f.settingsCatalog,
        effective: { "engine.maxTurns": 40 },
        secrets: {},
        sources: {},
      },
    }),
  ],
  [/^\/settings\/history$/, () => ({ body: { items: [] } })],
  [
    /^\/settings\/scopes$/,
    () => ({ body: { targets: [{ id: "camp1", name: "Ward round, Q4", detail: "open" }] } }),
  ],
  [/^\/providers$/, () => ({ body: { providers: [f.provider] } })],
  [
    /^\/providers\/[^/]+\/models$/,
    () => ({
      body: { models: [{ id: "claude-sonnet", name: "Claude Sonnet", inputPerMtok: 3, outputPerMtok: 15 }] },
    }),
  ],
  [/^\/providers\/[^/]+\/prices$/, () => ({ body: page("prices", []) })],
  [/^\/routes$/, () => ({ body: { routes: f.routes } })],
  [/^\/budgets$/, () => ({ body: page("budgets", f.budgets) })],
  [/^\/users$/, () => ({ body: page("users", f.users) })],
  [
    /^\/audit$/,
    () => ({
      body: page("entries", [
        {
          id: "a1",
          createdAt: "2026-10-14T09:30:00.000Z",
          action: "campaign.create",
          targetType: "campaign",
          targetId: "camp1",
          actorEmail: "ada@acme.test",
        },
      ]),
    }),
  ],
  [/^\/prompts$/, () => ({ body: { prompts: f.promptSummaries, windowDays: 30 } })],
  [/^\/prompts\/[^/]+$/, () => ({ body: f.promptDetail })],
  [
    /^\/admin\/voice\/readiness$/,
    () => ({
      body: {
        liveVoiceEnabled: false,
        recordedVoiceEnabled: true,
        purposes: {},
        canEnableLive: false,
        missing: ["tts"],
      },
    }),
  ],
  [/^\/operator\/tenants$/, () => ({ body: page("tenants", f.tenants) })],
  [/^\/operator\/providers$/, () => ({ body: { providers: [{ ...f.provider, companyId: null }] } })],
  [/^\/operator\/providers\/[^/]+\/models$/, () => ({ body: { models: [] } })],
  [/^\/operator\/providers\/[^/]+\/prices$/, () => ({ body: page("prices", []) })],
  [/^\/operator\/routes$/, () => ({ body: { routes: f.routes } })],
  [/^\/operator\/stats$/, () => ({ body: { platform: { tenants: 1, sessions: 15 } } })],
  [/^\/operator\/jobs$/, () => ({ body: { queues: [] } })],
  [/^\/operator\/jobs\/dead$/, () => ({ body: { jobs: [] } })],
  // Participant
  [/^\/p\/session$/, () => ({ body: { session: f.participantSession } })],
  [/^\/p\/session\/attachments$/, () => ({ body: { attachments: [] } })],
  [/^\/p\/session\/summary$/, () => ({ body: { summary: "", facts: [] } })],
  [
    /^\/p\/r\/[^/]+$/,
    () => ({
      body: {
        session: {
          title: "Ward handover assistant",
          purpose: "",
          consentText: "Consent.",
          consentVersion: "v1",
          pathSelection: "none",
          productName: "",
        },
      },
    }),
  ],
  [/^\/p\/closed-link$/, () => ({ body: f.linkInfo("closed") })],
  [/^\/p\/expired-link$/, () => ({ body: f.linkInfo("expired") })],
  [
    /^\/p\/missing-link$/,
    () => ({ status: 404, body: { error: { code: "not_found", message: "Link not found" } } }),
  ],
  [/^\/p\/[^/]+$/, () => ({ body: f.linkInfo("open") })],
];

function roleOf(req: IncomingMessage): "admin" | "member" | "platform_operator" {
  const v = req.headers["x-e2e-role"];
  return v === "member" || v === "platform_operator" ? v : "admin";
}

export interface FakeApi {
  server: Server;
  /** `METHOD path` of every request nothing answered. */
  misses: string[];
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function startFakeApi(port: number): Promise<FakeApi> {
  const misses: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (path === "/__misses") {
      send(res, 200, { misses });
      return;
    }
    if (path === "/__health") {
      send(res, 200, { ok: true });
      return;
    }
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      for (const [pattern, handler] of READS) {
        if (!pattern.test(path)) continue;
        const out = handler(url, req);
        if (out) {
          send(res, out.status ?? 200, out.body);
          return;
        }
      }
      misses.push(`${method} ${path}`);
      send(res, 404, { error: { code: "not_found", message: `The fake API has no answer for ${path}` } });
      return;
    }
    // Writes: drain the body and say it worked. Nothing is stored.
    req.resume();
    req.on("end", () => {
      send(res, 200, { ok: true, emailSent: false });
    });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        misses,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

// Run directly (`tsx e2e/fake-api.ts`): the web server is started against this process.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.E2E_API_PORT ?? 3199);
  void startFakeApi(port).then(() => {
    process.stdout.write(`fake API listening on ${String(port)}\n`);
  });
}
