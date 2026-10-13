import { settingDefault, type SettingKey } from "@aidp/shared";
import type { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  ALERT_KINDS,
  AlertRouter,
  MemoryAlertState,
  MemoryEmail,
  runbookAnchor,
  runbookRef,
  scrubText,
  webhookBody,
  type Alert,
  type RenderedAlert,
  type SettingsService,
} from "../src/index.js";

/** A settings service over a plain map: `platform` values, and per-tenant overrides. */
class FakeSettings {
  readonly platform = new Map<string, unknown>();
  readonly tenant = new Map<string, Map<string, unknown>>();

  setTenant(companyId: string, key: string, value: unknown): void {
    const m = this.tenant.get(companyId) ?? new Map<string, unknown>();
    m.set(key, value);
    this.tenant.set(companyId, m);
  }

  async resolveDetailed(
    keys: SettingKey[],
    chain: { scope: string; scopeId: string }[],
  ): Promise<Partial<Record<SettingKey, { value: unknown; scope: string | null; scopeId: string }>>> {
    const out: Partial<Record<SettingKey, { value: unknown; scope: string | null; scopeId: string }>> = {};
    for (const key of keys) {
      const t = chain.find((c) => c.scope === "tenant");
      const tv = t ? this.tenant.get(t.scopeId)?.get(key) : undefined;
      if (tv !== undefined) out[key] = { value: tv, scope: "tenant", scopeId: t?.scopeId ?? "" };
      else if (this.platform.has(key))
        out[key] = { value: this.platform.get(key), scope: "platform", scopeId: "" };
      else out[key] = { value: settingDefault(key), scope: null, scopeId: "" };
    }
    return out;
  }

  async get(key: SettingKey, chain: { scope: string; scopeId: string }[]): Promise<unknown> {
    return (await this.resolveDetailed([key], chain))[key]?.value;
  }
}

interface Rig {
  router: AlertRouter;
  state: MemoryAlertState;
  email: MemoryEmail;
  settings: FakeSettings;
  posts: { url: string; body: unknown }[];
  audits: { companyId: string; action: string; targetId: string; diff: unknown }[];
  clock: { now: Date };
  failWebhook: { on: boolean };
  admins: Record<string, string[]>;
}

function rig(opts: { webhookUrl?: string; operatorEmail?: string | null } = {}): Rig {
  const settings = new FakeSettings();
  const email = new MemoryEmail();
  const state = new MemoryAlertState();
  const posts: Rig["posts"] = [];
  const audits: Rig["audits"] = [];
  const clock = { now: new Date("2026-10-13T10:00:00Z") };
  const failWebhook = { on: false };
  const admins: Record<string, string[]> = {};
  if (opts.webhookUrl !== undefined) settings.platform.set("ops.alertWebhookUrl", opts.webhookUrl);
  const db = {
    user: {
      findMany: async ({ where }: { where: { companyId: string } }) =>
        (admins[where.companyId] ?? []).map((e) => ({ email: e })),
      findFirst: async () =>
        opts.operatorEmail === null
          ? null
          : { companyId: "platform-co", email: opts.operatorEmail ?? "ops@example.com" },
    },
    auditLog: {
      create: async ({ data }: { data: Rig["audits"][number] }) => {
        audits.push(data);
      },
    },
  } as unknown as PrismaClient;
  const router = new AlertRouter({
    db,
    state,
    settings: settings as unknown as SettingsService,
    email,
    publicWebUrl: "https://pilot.example.com",
    now: () => clock.now,
    fetch: (async (url: string, init: { body: string }) => {
      if (failWebhook.on) return new Response("no", { status: 500 });
      posts.push({ url, body: JSON.parse(init.body) as unknown });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { router, state, email, settings, posts, audits, clock, failWebhook, admins };
}

const dead = (over: Partial<Alert> = {}): Alert => ({
  kind: "job.dead_lettered",
  key: "job.dead_lettered:analysis.run:j1",
  title: "Job dead-lettered: analysis.run",
  message: "An analysis.run job failed its last attempt.",
  context: { queue: "analysis.run", jobId: "j1" },
  ...over,
});

describe("the alert catalog", () => {
  it("anchors every kind to a runbook heading GitHub would generate", () => {
    expect(runbookAnchor("job.dead_lettered")).toBe("jobdead_lettered");
    expect(runbookAnchor("budget.exceeded")).toBe("budgetexceeded");
    expect(runbookRef("disk.high")).toBe("docs/OPERATIONS.md#diskhigh");
  });

  it("keeps tenant mail to the two budget kinds", () => {
    const tenantFacing = Object.entries(ALERT_KINDS)
      .filter(([, spec]) => (spec.audience as readonly string[]).includes("tenant_admins"))
      .map(([kind]) => kind)
      .sort();
    expect(tenantFacing).toEqual(["budget.exceeded", "budget.warning"]);
  });
});

describe("AlertRouter", () => {
  it("emails the operator and posts the webhook for a critical alert, with the runbook", async () => {
    const r = rig({ webhookUrl: "https://ntfy.example.com/aidp" });
    const result = await r.router.raise(dead());
    expect(result).toEqual({ delivered: true, suppressed: null });
    expect(r.email.sent).toHaveLength(1);
    expect(r.email.sent[0]).toMatchObject({ to: "ops@example.com" });
    expect(r.email.sent[0]?.subject).toBe("[aidp pilot.example.com] Job dead-lettered: analysis.run");
    expect(r.email.sent[0]?.text).toContain("What to do: docs/OPERATIONS.md#jobdead_lettered");
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.url).toBe("https://ntfy.example.com/");
    expect(r.posts[0]?.body).toMatchObject({ topic: "aidp", priority: 5 });
  });

  it("sends a repeat once, not twice, and says the first one still stands", async () => {
    const r = rig({ webhookUrl: "https://ntfy.example.com/aidp" });
    await r.router.raise(dead());
    const again = await r.router.raise(dead());
    expect(again).toEqual({ delivered: true, suppressed: "duplicate" });
    expect(r.email.sent).toHaveLength(1);
    expect(r.state.rows.get("job.dead_lettered:analysis.run:j1")?.count).toBe(2);
  });

  it("sends again after the repeat window, and again at once after a resolve", async () => {
    const r = rig();
    await r.router.raise(dead());
    r.clock.now = new Date(r.clock.now.getTime() + 25 * 3_600_000);
    expect((await r.router.raise(dead())).suppressed).toBeNull();
    expect(r.email.sent).toHaveLength(2);

    await r.router.resolve(dead().key);
    expect((await r.router.raise(dead())).suppressed).toBeNull();
    expect(r.email.sent).toHaveLength(3);
  });

  it("lets an explicit ops.alertRepeatMinutes replace every kind's window", async () => {
    const r = rig();
    r.settings.platform.set("ops.alertRepeatMinutes", 5);
    await r.router.raise(dead());
    r.clock.now = new Date(r.clock.now.getTime() + 6 * 60_000);
    expect((await r.router.raise(dead())).suppressed).toBeNull();
    expect(r.email.sent).toHaveLength(2);
  });

  it("applies the per-channel severity floors", async () => {
    const r = rig({ webhookUrl: "https://hooks.example.com/x" });
    r.settings.platform.set("ops.alertWebhookMinSeverity", "warning");
    // info is below the email floor (warning) and the webhook floor, so nothing goes anywhere.
    const info = await r.router.raise({
      kind: "budget.warning",
      key: "budget.warning:tenant:t1:2026-10:80",
      title: "Budget at 83%",
      message: "m",
    });
    expect(info).toEqual({ delivered: false, suppressed: "below_min_severity" });
    expect(r.email.sent).toHaveLength(0);
    expect(r.posts).toHaveLength(0);
  });

  it("sends an info alert to the webhook only, because the email floor is warning", async () => {
    const r = rig({ webhookUrl: "https://hooks.example.com/x" });
    r.settings.platform.set("ops.alertWebhookFormat", "generic");
    await r.router.raise({
      kind: "budget.warning",
      key: "budget.warning:tenant:t1:2026-10:80",
      title: "Budget at 83%",
      message: "m",
    });
    expect(r.email.sent).toHaveLength(0);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]?.body).toMatchObject({ kind: "budget.warning", severity: "info" });
  });

  it("reports nothing delivered, and retries at once, when every channel fails", async () => {
    // No operator address anywhere, so the webhook is the only channel, and it is failing.
    const r = rig({ webhookUrl: "https://hooks.example.com/x", operatorEmail: null });
    r.failWebhook.on = true;
    const first = await r.router.raise(dead());
    expect(first).toEqual({ delivered: false, suppressed: null });

    r.failWebhook.on = false;
    const second = await r.router.raise(dead());
    expect(second).toEqual({ delivered: true, suppressed: null });
    expect(r.posts).toHaveLength(1);
  });

  it("rate limits per audience and sends exactly one storm notice", async () => {
    const r = rig();
    r.settings.platform.set("ops.alertMaxPerHour", 3);
    const outcomes: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await r.router.raise(dead({ key: `job.dead_lettered:q:${i}` }));
      outcomes.push(res.suppressed);
    }
    expect(outcomes).toEqual([null, null, null, "rate_limited", "rate_limited", "rate_limited"]);
    const subjects = r.email.sent.map((m) => m.subject);
    expect(subjects.filter((s) => s.includes("Alerts are being suppressed"))).toHaveLength(1);
    // Three alerts plus the one storm notice, nothing more.
    expect(r.email.sent).toHaveLength(4);
  });

  it("scrubs addresses out of an alert before it leaves the box", async () => {
    const r = rig();
    await r.router.raise(
      dead({ message: "Failed for alice@example.com while sending", context: { who: "bob@example.com" } }),
    );
    const text = r.email.sent[0]?.text ?? "";
    expect(text).not.toContain("alice@example.com");
    expect(text).not.toContain("bob@example.com");
    expect(text).toContain("[email]");
  });

  it("never throws, even when the store does", async () => {
    const r = rig();
    r.state.record = async () => {
      throw new Error("db down");
    };
    await expect(r.router.raise(dead())).resolves.toEqual({ delivered: false, suppressed: null });
  });

  it("writes an audit row for what it sent, on the tenant or the platform company", async () => {
    const r = rig();
    await r.router.raise(dead());
    await r.router.raise({
      kind: "budget.exceeded",
      key: "budget.exceeded:tenant:t1:2026-10",
      companyId: "t1",
      title: "Budget used up",
      message: "m",
    });
    expect(r.audits.map((a) => [a.companyId, a.action])).toEqual([
      ["platform-co", "alert.sent"],
      ["t1", "alert.sent"],
    ]);
    // The audit diff names the kind and the channels. It never carries the message.
    expect(JSON.stringify(r.audits[0]?.diff)).not.toContain("failed its last attempt");
  });

  describe("tenant notices", () => {
    const exceeded = (companyId: string): Alert => ({
      kind: "budget.exceeded",
      key: `budget.exceeded:tenant:${companyId}:2026-10`,
      companyId,
      title: "Budget used up: workspace",
      message: "The budget is used up.",
    });

    it("mails only the admins of the tenant the alert belongs to", async () => {
      const r = rig();
      r.admins.t1 = ["a@t1.example", "b@t1.example"];
      r.admins.t2 = ["c@t2.example"];
      r.settings.setTenant("t1", "branding.productName", "Acme Discovery");
      await r.router.raise(exceeded("t1"));
      const toTenant = r.email.sent.filter((m) => m.companyId === "t1").map((m) => m.to);
      expect(toTenant.sort()).toEqual(["a@t1.example", "b@t1.example"]);
      expect(r.email.sent.some((m) => m.to === "c@t2.example")).toBe(false);
      const subject = r.email.sent.find((m) => m.to === "a@t1.example")?.subject;
      expect(subject).toBe("[Acme Discovery] Budget used up: workspace");
      // The operator is told too, through the platform configuration (no tenant id on the message).
      expect(r.email.sent.some((m) => m.to === "ops@example.com" && m.companyId === undefined)).toBe(true);
    });

    it("honours notifications.recipients as the whole list", async () => {
      const r = rig();
      r.admins.t1 = ["admin@t1.example"];
      r.settings.setTenant("t1", "notifications.recipients", ["finance@t1.example"]);
      await r.router.raise(exceeded("t1"));
      expect(r.email.sent.filter((m) => m.companyId === "t1").map((m) => m.to)).toEqual([
        "finance@t1.example",
      ]);
    });

    it("lets a tenant turn off its own warnings and never its own exhaustion", async () => {
      const r = rig();
      r.admins.t1 = ["admin@t1.example"];
      r.settings.setTenant("t1", "notifications.budgetWarnings", false);
      await r.router.raise({
        kind: "budget.warning",
        key: "budget.warning:tenant:t1:2026-10:80",
        companyId: "t1",
        title: "Budget at 83%",
        message: "m",
      });
      expect(r.email.sent.filter((m) => m.companyId === "t1")).toHaveLength(0);
      await r.router.raise(exceeded("t1"));
      expect(r.email.sent.filter((m) => m.companyId === "t1")).toHaveLength(1);
    });

    it("cannot be talked into mailing a tenant an operator-only kind", async () => {
      const r = rig();
      r.admins.t1 = ["admin@t1.example"];
      await r.router.raise(
        dead({ companyId: "t1", audience: ["operator", "tenant_admins"], key: "job.dead_lettered:x:1" }),
      );
      expect(r.email.sent.map((m) => m.to)).toEqual(["ops@example.com"]);
    });

    it("sends no tenant mail for a tenant alert that names no tenant", async () => {
      const r = rig();
      r.admins.t1 = ["admin@t1.example"];
      await r.router.raise({
        kind: "budget.exceeded",
        key: "budget.exceeded:tenant:?:2026-10",
        title: "t",
        message: "m",
      });
      expect(r.email.sent.map((m) => m.to)).toEqual(["ops@example.com"]);
    });
  });
});

describe("webhook bodies", () => {
  const alert: RenderedAlert = {
    kind: "disk.high",
    severity: "critical",
    key: "disk.high:critical",
    title: "Disk 93% used",
    message: "Disk is 93% used.",
    companyId: undefined,
    occurredAt: new Date("2026-10-13T10:00:00Z"),
    count: 1,
    context: { percent: 93 },
    links: [],
    runbook: "docs/OPERATIONS.md#diskhigh",
  };

  it("publishes ntfy as JSON to the server root so a non-Latin title survives", () => {
    const out = webhookBody(
      "ntfy",
      "https://ntfy.sh/aidp-ops",
      { ...alert, title: "Levy 93 % täynnä" },
      "[aidp x]",
    );
    expect(out.url).toBe("https://ntfy.sh/");
    expect(JSON.parse(out.body)).toMatchObject({
      topic: "aidp-ops",
      title: "[aidp x] Levy 93 % täynnä",
      priority: 5,
      tags: ["rotating_light"],
    });
  });

  it("sends Slack text plus one section block", () => {
    const body = JSON.parse(webhookBody("slack", "https://hooks.slack.com/x", alert, "[aidp x]").body) as {
      text: string;
      blocks: { type: string }[];
    };
    expect(body.text).toContain("Disk 93% used");
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]?.type).toBe("section");
  });

  it("sends the generic shape the shell sidecar also sends", () => {
    const body = JSON.parse(
      webhookBody("generic", "https://example.com/h", alert, "[aidp x]").body,
    ) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "context",
        "count",
        "companyId",
        "key",
        "kind",
        "links",
        "message",
        "occurredAt",
        "runbook",
        "severity",
        "title",
      ].sort(),
    );
  });
});

describe("scrubText", () => {
  it("flattens whitespace, hides addresses and bounds the length", () => {
    expect(scrubText("a\n  b  carol@example.com", 100)).toBe("a b [email]");
    expect(scrubText("x".repeat(50), 10)).toHaveLength(10);
  });
});
