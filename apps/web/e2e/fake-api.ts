import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import * as f from "./fixtures";
import { participantVariant } from "./participant-variants";

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

const page = (key: string, rows: unknown[]): Record<string, unknown> => ({
  [key]: rows,
  total: rows.length,
  limit: 25,
  offset: 0,
});

/**
 * A list the way the API serves one (contract 19): searched on `q`, narrowed by the named filters,
 * sorted on `sort` and `dir`, then windowed by `limit` and `offset`, with the full `total`. The
 * fixtures are generated, so the table pages have enough rows to page through.
 */
function listOf<T extends Record<string, unknown>>(
  key: string,
  all: T[],
  url: URL,
  options: { search: (keyof T & string)[]; filters?: Record<string, (row: T, value: string) => boolean> },
): Record<string, unknown> {
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  let rows = all.filter(
    (r) =>
      !q ||
      options.search.some((k) =>
        String(r[k] ?? "")
          .toLowerCase()
          .includes(q),
      ),
  );
  for (const [name, match] of Object.entries(options.filters ?? {})) {
    const v = url.searchParams.get(name);
    if (v) rows = rows.filter((r) => match(r, v));
  }
  const sort = url.searchParams.get("sort");
  if (sort) {
    const dir = url.searchParams.get("dir") === "desc" ? -1 : 1;
    rows = [...rows].sort(
      (a, b) =>
        `${(a[sort] as string | number | null) ?? ""}`.localeCompare(
          `${(b[sort] as string | number | null) ?? ""}`,
        ) * dir,
    );
  }
  const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50) || 50);
  const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
  return { [key]: rows.slice(offset, offset + limit), total: rows.length, limit, offset };
}

const STATUSES = ["draft", "open", "analyzing", "closed"] as const;
const manyCampaigns = Array.from({ length: 37 }, (_v, i) => ({
  ...f.campaign,
  id: `camp${String(i + 1)}`,
  name:
    i === 0
      ? f.campaign.name
      : `${["Ward round", "Pharmacy", "Intake", "Billing", "Discharge"][i % 5] ?? "Round"} ${String(2026 - (i % 3))} Q${String((i % 4) + 1)}`,
  status: STATUSES[i % 4] ?? "open",
  createdAt: new Date(Date.UTC(2026, 9, 14 - (i % 28), 9, 30)).toISOString(),
  stats: { invited: 24 + i, started: 15 + (i % 9), completed: 11 + (i % 7), dropOffByArea: {} },
}));
const manyUsers = Array.from({ length: 23 }, (_v, i) => ({
  id: i === 0 ? "u1" : `u${String(i + 1)}`,
  email: i === 0 ? "ada@acme.test" : `person${String(i)}@acme.test`,
  name: i === 0 ? "Ada Admin" : i % 5 === 0 ? null : `Person ${String(i)}`,
  role: i === 0 || i % 7 === 0 ? "admin" : "member",
  status: "active",
  createdAt: new Date(Date.UTC(2026, 8, 1 + i, 8)).toISOString(),
  disabledAt: i % 9 === 4 ? "2026-10-01T08:00:00.000Z" : null,
}));
const ACTIONS = [
  "campaign.create",
  "campaign.open",
  "user.create",
  "user.update",
  "settings.update",
  "template.published",
  "campaign.invite",
];
const manyAudit = Array.from({ length: 120 }, (_v, i) => ({
  id: `a${String(i + 1)}`,
  createdAt: new Date(Date.UTC(2026, 9, 14, 9, 30) - i * 3_600_000 * 5).toISOString(),
  action: ACTIONS[i % ACTIONS.length] ?? "campaign.create",
  targetType: (ACTIONS[i % ACTIONS.length] ?? "campaign.create").split(".")[0],
  targetId: `id${String(i)}`,
  actorEmail: i % 3 === 0 ? "ada@acme.test" : "ben@acme.test",
  diff: i % 2 === 0 ? { name: `Change ${String(i)}`, status: "open" } : null,
}));

/**
 * Page states a design review needs and a plain fixture would never show: a campaign id names the
 * state (`campEmpty` has no rows anywhere, `campErr` fails its lists, `campLong` has very long names).
 */
const campaignIdOf = (u: URL): string => /\/campaigns\/([^/]+)/.exec(u.pathname)?.[1] ?? "camp1";
const INVITE_STATUSES = ["sent", "opened", "bound", "pending", "revoked", "expired"] as const;
const manyInvitations = Array.from({ length: 64 }, (_v, i) => ({
  id: `inv${String(i + 1)}`,
  email:
    i % 11 === 10
      ? null
      : `${["kim", "lee", "aino", "mika", "sara", "olli", "jenni"][i % 7] ?? "x"}.${String(i)}@acme.test`,
  status: INVITE_STATUSES[i % INVITE_STATUSES.length] ?? "sent",
  sentAt: new Date(Date.UTC(2026, 9, 1 + (i % 12), 9)).toISOString(),
  openedAt: i % 3 === 0 ? null : new Date(Date.UTC(2026, 9, 2 + (i % 12), 11)).toISOString(),
  expiresAt: "2026-11-30T00:00:00.000Z",
}));
const manySessions = Array.from({ length: 41 }, (_v, i) => ({
  ...f.sessions[i % 2],
  id: `sess${String(i + 1).padStart(4, "0")}abcdef`,
  status: (["completed", "active", "paused", "created"] as const)[i % 4],
  flagged: i % 5 === 1,
  participantName: i % 3 === 0 ? null : `Participant ${String(i)}`,
  participantEmail: i % 3 === 0 ? null : `p${String(i)}@acme.test`,
  costCents: 2 + i,
  lastActivityAt: new Date(Date.UTC(2026, 9, 14 - (i % 20), 10)).toISOString(),
}));
const longName =
  "Quarterly cross-functional discovery programme for the regional hospital district's inpatient ward rounds and discharge coordination 2026";

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
  [
    /^\/campaigns$/,
    (u) => ({
      body: listOf("campaigns", manyCampaigns, u, {
        search: ["name"],
        filters: { status: (r, v) => r.status === v },
      }),
    }),
  ],
  [
    /^\/campaigns\/[^/]+$/,
    (u) => {
      const id = campaignIdOf(u);
      const campaign = {
        ...f.campaign,
        id,
        ...(id === "campLong" ? { name: longName } : {}),
        ...(id === "campDraft" ? { status: "draft" } : {}),
      };
      return { body: { campaign, link: campaign.link, stats: campaign.stats } };
    },
  ],
  [
    /^\/campaigns\/[^/]+\/invitations$/,
    (u) => {
      const id = campaignIdOf(u);
      if (id === "campErr")
        return {
          status: 500,
          body: { error: { code: "internal", message: "The invitations could not be read." } },
        };
      return {
        body: listOf("invitations", id === "campEmpty" ? [] : manyInvitations, u, {
          search: ["email"],
          filters: { status: (r, v) => r.status === v },
        }),
      };
    },
  ],
  [
    /^\/campaigns\/[^/]+\/sessions$/,
    (u) => {
      const id = campaignIdOf(u);
      if (id === "campErr")
        return {
          status: 500,
          body: { error: { code: "internal", message: "The interviews could not be read." } },
        };
      return {
        body: listOf("sessions", id === "campEmpty" ? [] : manySessions, u, {
          search: ["id", "participantName", "participantEmail"],
          filters: {
            status: (r, v) => r.status === v,
            flagged: (r, v) => String(r.flagged) === v,
          },
        }),
      };
    },
  ],
  [
    /^\/campaigns\/[^/]+\/analyses$/,
    (u) => ({ body: page("analyses", campaignIdOf(u) === "campEmpty" ? [] : [f.analysis]) }),
  ],
  [
    /^\/analyses\/[^/]+$/,
    () => ({ body: { analysis: f.analysis, opportunities: f.analysisDetail.opportunities, report: null } }),
  ],
  [/^\/analyses\/[^/]+\/departments$/, () => ({ body: f.departments })],
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
    /^\/requirements\/[^/]+$/,
    (u) => ({
      body: u.pathname.endsWith("/reqd") ? f.requirementsDetailWithDiagrams : f.requirementsDetail,
    }),
  ],
  [/^\/requirements\/[^/]+\/versions$/, () => ({ body: { versions: f.specVersions } })],
  [
    /^\/requirements\/[^/]+\/versions\/[^/]+$/,
    (u) => ({
      body: u.pathname.includes("/reqd/") ? f.specVersionDetailWithDiagrams : f.specVersionDetail,
    }),
  ],
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
  [
    /^\/users$/,
    (u) => ({
      body: listOf("users", manyUsers, u, {
        search: ["email", "name"],
        filters: { role: (r, v) => r.role === v },
      }),
    }),
  ],
  [
    /^\/audit$/,
    (u) => ({
      body: listOf("entries", manyAudit, u, {
        search: ["action", "actorEmail"],
        filters: {
          action: (r, v) => (v.endsWith(".") ? r.action.startsWith(v) : r.action === v),
          from: (r, v) => r.createdAt.slice(0, 10) >= v,
          to: (r, v) => r.createdAt.slice(0, 10) <= v,
        },
      }),
    }),
  ],
  [
    /^\/audit\.csv$/,
    () => ({ body: "created_at,actor,action\r\n2026-10-14T09:30:00.000Z,ada@acme.test,campaign.create\r\n" }),
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
  [
    /^\/operator\/health$/,
    () => ({
      body: {
        generatedAt: "2026-10-14T08:00:00.000Z",
        version: "2026.10",
        signals: [
          { key: "backup", status: "ok", detail: "Last backup 3 hours ago", value: 3 },
          { key: "disk", status: "warn", detail: "Disk at 82 percent", value: 82 },
        ],
        providers: [
          {
            providerId: "prov_1",
            name: "OpenRouter",
            calls: 120,
            failed: 2,
            errorRate: 0.017,
            circuit: "closed",
          },
        ],
        latency: {
          firstTokenP50Ms24h: 900,
          firstTokenP95Ms24h: 2100,
          firstTokenTargetMs: 2000,
          voiceFirstWordP95Ms24h: null,
          voiceFirstWordTargetMs: 1500,
        },
        backup: {
          lastResult: "ok",
          lastSuccessAt: "2026-10-14T05:00:00.000Z",
          ageHours: 3,
          offsite: "ok",
          drill: { result: "ok", at: "2026-10-12T03:00:00.000Z", error: null, durationS: 94 },
        },
        tenants: [],
      },
    }),
  ],
  [/^\/operator\/jobs$/, () => ({ body: { queues: [] } })],
  [/^\/operator\/jobs\/dead$/, () => ({ body: { jobs: [] } })],
  // Participant
  [
    /^\/p\/session$/,
    (_u, req) => ({
      body: {
        session: participantVariant(req.headers.authorization ?? ""),
      },
    }),
  ],
  [/^\/p\/session\/attachments$/, () => ({ body: { attachments: [] } })],
  [
    /^\/p\/session\/summary$/,
    () => ({
      body: {
        summary: "You described how handover notes get lost between shifts.",
        facts: [],
        status: "ready",
      },
    }),
  ],
  [/^\/p\/r\/[^/]+$/, () => ({ body: f.inviteArrival })],
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
  if (typeof body === "string") {
    // A file (the CSV exports): sent as it is, with the headers a download carries.
    res.writeHead(status, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="audit-log-2026-10-14.csv"',
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return;
  }
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
    // Writes: drain the body and say it worked. Nothing is stored. Opening a link is the one write
    // whose answer the page parses: a token grant, which the web server turns into the cookie.
    const opensLink = method === "POST" && /^\/p\/(?:r\/)?[^/]+\/open$/.test(path);
    req.resume();
    req.on("end", () => {
      if (opensLink) {
        send(res, 200, { participantToken: "e2e-participant-token", sessionId: "sess9", resume: false });
        return;
      }
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
