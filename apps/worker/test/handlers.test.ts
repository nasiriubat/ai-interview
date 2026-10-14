import { randomBytes } from "node:crypto";
import { ShippedPromptSource, promptVersionTag, SHIPPED_PROMPTS } from "@aidp/ai";
import {
  EmailInFlightError,
  EMAIL_CLAIM_LEASE_MS,
  JOBS,
  MemoryEmail,
  MemoryEmailOutbox,
  MemoryJobPublisher,
  MemoryStorage,
  Crypto as RealCrypto,
  type Crypto,
  type JobName,
  type SettingsService,
  TenantGate,
} from "@aidp/core";
import { currentTenant, shippedTemplate, SYSTEM_TENANT } from "@aidp/db";
import { MemorySessionStore, ScriptedModel } from "@aidp/testing";
import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { handlers, type HandlerDeps } from "../src/handlers.js";

/**
 * Handler behaviour with in-memory stores and no database (plan 4.2).
 *
 * The question for every job is the one the queue forces: it will be run again. Each handler here
 * is called twice and must leave the world as if it had been called once, and the one that throws
 * halfway must leave what it finished durable and finish the rest on the retry.
 */

const template = shippedTemplate("opportunity_discovery")!;

const task = (name: string) => ({
  kind: "task",
  name,
  frequency: "daily",
  minutesPerOccurrence: 5,
  tools: [],
  painScore: 1,
});
const extraction = (...names: string[]) => JSON.stringify({ facts: names.map(task) });

interface Harness {
  sessions: MemorySessionStore;
  model: ScriptedModel;
  email: MemoryEmail;
  outbox: MemoryEmailOutbox;
  jobs: MemoryJobPublisher;
  storage: MemoryStorage;
  settingsAsked: { key: string; chain: unknown }[];
  h: ReturnType<typeof handlers>;
  deps: HandlerDeps;
}

function harness(over: { email?: MemoryEmail } = {}): Harness {
  const sessions = new MemorySessionStore({ template });
  const model = new ScriptedModel();
  const email = over.email ?? new MemoryEmail();
  const outbox = new MemoryEmailOutbox();
  const jobs = new MemoryJobPublisher();
  const storage = new MemoryStorage();
  const settingsAsked: { key: string; chain: unknown }[] = [];
  const deps: HandlerDeps = {
    // Nothing below touches these: the stores that would are injected.
    db: {} as unknown as PrismaClient,
    crypto: {} as unknown as Crypto,
    callers: { forCompany: async () => model } as unknown as HandlerDeps["callers"],
    // Every tenant is active here; suspension is covered in the API and gate tests.
    tenants: new TenantGate({
      company: { findUnique: async () => ({ status: "active" }) },
    } as unknown as ConstructorParameters<typeof TenantGate>[0]),
    settings: {
      get: async (key: string, chain: unknown) => {
        settingsAsked.push({ key, chain });
        return 4;
      },
    } as unknown as SettingsService,
    email,
    jobs,
    storage,
    log: { info: () => undefined, warn: () => undefined },
    publicWebUrl: "http://localhost:3000",
    sessions,
    outbox,
    prompts: new ShippedPromptSource(),
  };
  return { sessions, model, email, outbox, jobs, storage, settingsAsked, h: handlers(deps), deps };
}

async function backlog(store: MemorySessionStore, turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await store.appendMessage("s1", { role: "assistant", modality: "text", content: `Question ${i}?` });
    await store.appendMessage("s1", { role: "user", modality: "text", content: `Answer ${i}` });
  }
}

const payload = { sessionId: "s1", companyId: "c1" };

describe("session.extract", () => {
  let t: Harness;
  beforeEach(() => {
    t = harness();
  });

  it("run twice gives the same state and rows, and the second run asks the model nothing", async () => {
    await backlog(t.sessions, 12);
    t.model.enqueue(extraction("a", "b"));

    await t.h["session.extract"](payload);
    const after = { state: t.sessions.state, rows: [...t.sessions.factRows] };
    await t.h["session.extract"](payload);

    expect(t.model.calls).toHaveLength(1);
    expect(t.sessions.state).toEqual(after.state);
    expect(t.sessions.factRows).toEqual(after.rows);
    expect(t.sessions.factRows).toHaveLength(2);
  });

  it("a throw on batch 2 of 3 leaves batch 1 durable, and the retry finishes", async () => {
    await backlog(t.sessions, 30);
    t.model.enqueue(extraction("a"), new Error("provider down"));

    await expect(t.h["session.extract"](payload)).rejects.toThrow("provider down");
    expect(t.sessions.factRows.map((r) => r.batchEndSeq)).toEqual([24]);
    expect(t.sessions.state.lastExtractedSeq).toBe(24);

    t.model.enqueue(extraction("b"), extraction("c"));
    await t.h["session.extract"](payload);

    expect(t.sessions.factRows.map((r) => r.batchEndSeq)).toEqual([24, 48, 60]);
    expect(t.sessions.state.facts).toHaveLength(3);
  });

  it("stamps the version of the prompt it actually used, never a literal", async () => {
    await backlog(t.sessions, 2);
    t.model.enqueue(extraction("a"));

    await t.h["session.extract"](payload);

    const tag = promptVersionTag(SHIPPED_PROMPTS.extraction!);
    expect(t.sessions.factRows[0]?.extractorVersion).toBe(tag);
    expect(t.model.calls[0]?.ctx.promptVersion).toBe(tag);
  });

  it("is a no-op for a deleted session", async () => {
    await backlog(t.sessions, 2);
    t.sessions.status = "deleted";

    await t.h["session.extract"](payload);

    expect(t.model.calls).toHaveLength(0);
    expect(t.sessions.factRows).toHaveLength(0);
  });
});

describe("session.summarize", () => {
  it("run twice makes one model call, and reads the window from the template then tenant chain", async () => {
    const t = harness();
    await backlog(t.sessions, 12);
    t.model.enqueue("Summary: invoices are reconciled weekly.");

    await t.h["session.summarize"](payload);
    await t.h["session.summarize"](payload);

    expect(t.model.callsFor("resume_summary")).toHaveLength(1);
    expect(t.sessions.summary).toContain("reconciled");
    expect(t.settingsAsked[0]).toMatchObject({
      key: "engine.recentWindowTurns",
      chain: [
        { scope: "template", scopeId: "" },
        { scope: "tenant", scopeId: "c1" },
      ],
    });
  });

  it("is a no-op for a deleted session", async () => {
    const t = harness();
    await backlog(t.sessions, 12);
    t.sessions.status = "deleted";

    await t.h["session.summarize"](payload);

    expect(t.model.calls).toHaveLength(0);
  });
});

describe("email.send", () => {
  const message = {
    to: "a@example.com",
    subject: "Your code",
    text: "123456",
    companyId: "c1",
    idempotencyKey: "code:abc",
  };

  it("run twice sends once", async () => {
    const t = harness();

    await t.h["email.send"](message);
    await t.h["email.send"](message);

    expect(t.email.sent).toHaveLength(1);
  });

  it("two different keys to the same address both send", async () => {
    const t = harness();

    await t.h["email.send"](message);
    await t.h["email.send"]({ ...message, idempotencyKey: "code:def" });

    expect(t.email.sent).toHaveLength(2);
  });

  it("a send that fails releases the claim, so the retry sends exactly once", async () => {
    const t = harness();
    let failNext = true;
    const send = t.email.send.bind(t.email);
    t.email.send = async (m) => {
      if (failNext) {
        failNext = false;
        throw new Error("smtp unavailable");
      }
      return send(m);
    };

    await expect(t.h["email.send"](message)).rejects.toThrow("smtp unavailable");
    await t.h["email.send"](message);
    await t.h["email.send"](message);

    expect(t.email.sent).toHaveLength(1);
  });

  it("a claim held by a live attempt makes the retry wait rather than send beside it", async () => {
    const t = harness();
    await t.outbox.claim("code:abc", "c1", new Date(), EMAIL_CLAIM_LEASE_MS);

    await expect(t.h["email.send"](message)).rejects.toBeInstanceOf(EmailInFlightError);

    expect(t.email.sent).toHaveLength(0);
  });

  it("a claim abandoned by a crash is taken over after the lease, and sent once", async () => {
    const t = harness();
    // Claimed, then the process died before sending: the row is `sending` and old.
    await t.outbox.claim(
      "code:abc",
      "c1",
      new Date(Date.now() - EMAIL_CLAIM_LEASE_MS - 1000),
      EMAIL_CLAIM_LEASE_MS,
    );

    await t.h["email.send"](message);
    await t.h["email.send"](message);

    expect(t.email.sent).toHaveLength(1);
  });

  it("two concurrent handlers send once", async () => {
    const t = harness();
    // Hold the send open so both handlers are past their claim at the same time.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = t.email.send.bind(t.email);
    t.email.send = async (m) => {
      await gate;
      return send(m);
    };

    const first = t.h["email.send"](message);
    const second = t.h["email.send"](message).catch((e: unknown) => e);
    release();
    await first;
    const loser = await second;

    expect(t.email.sent).toHaveLength(1);
    // The loser either saw the claim in flight (retried later by the queue) or the finished send.
    expect(loser === undefined || loser instanceof EmailInFlightError).toBe(true);
  });

  it("will not accept a payload without an idempotency key", () => {
    const { idempotencyKey: _omit, ...withoutKey } = message;

    expect(JOBS["email.send"].schema.safeParse(withoutKey).success).toBe(false);
  });
});

describe("privacy.confirm-deletion", () => {
  // The real cipher: what the API encrypts with is what the worker decrypts with.
  const cipher = new RealCrypto(randomBytes(32).toString("base64"));
  const job = {
    companyId: "c1",
    sessionId: "s1",
    toEnc: cipher.encrypt("ida@clinic.test"),
    campaignName: "Ward interviews",
    language: "en",
    deletedAt: "2026-10-14T09:00:00.000Z",
  };
  const withCrypto = (t: Harness): void => {
    t.deps.crypto = cipher;
  };

  it("decrypts the address, sends the notice once under deletion-notice:<session>, and keeps no copy", async () => {
    const t = harness();
    withCrypto(t);

    await t.h["privacy.confirm-deletion"](job);
    await t.h["privacy.confirm-deletion"](job);

    expect(t.email.sent).toHaveLength(1);
    expect(t.email.sent[0]).toMatchObject({ to: "ida@clinic.test", companyId: "c1" });
    expect(t.email.sent[0]?.subject).toContain("Ward interviews");
    expect(t.email.sent[0]?.text).toContain("2026-10-14");
    expect(t.email.sent[0]?.text).not.toContain("s1");
    expect(await t.outbox.claim("deletion-notice:s1", "c1", new Date(), EMAIL_CLAIM_LEASE_MS)).toBe(
      "already_sent",
    );
  });

  it("writes the notice in Finnish for a Finnish interview", async () => {
    const t = harness();
    withCrypto(t);

    await t.h["privacy.confirm-deletion"]({ ...job, language: "fi" });

    expect(t.email.sent[0]?.subject).toContain("poistettu");
  });

  it("will not accept a payload with a plaintext address field instead of the ciphertext", () => {
    const { toEnc: _omit, ...without } = job;

    expect(JOBS["privacy.confirm-deletion"].schema.safeParse({ ...without, to: "a@b.c" }).success).toBe(
      false,
    );
  });
});

describe("tenant scope", () => {
  it("runs a job with a company under that tenant, and one without under the system tenant", async () => {
    const seen: (string | null)[] = [];
    const email = new MemoryEmail(() => {
      seen.push(currentTenant());
    });
    const t = harness({ email });

    await t.h["email.send"]({ to: "a@x.io", subject: "s", text: "t", companyId: "c1", idempotencyKey: "k1" });
    await t.h["email.send"]({ to: "b@x.io", subject: "s", text: "t", idempotencyKey: "k2" });

    expect(seen).toEqual(["c1", SYSTEM_TENANT]);
  });

  it("keeps two interleaved jobs for different tenants apart", async () => {
    const seen = new Map<string, string | null>();
    let arrived = 0;
    let open!: () => void;
    const barrier = new Promise<void>((resolve) => {
      open = resolve;
    });
    const email = new MemoryEmail();
    const t = harness({ email });
    // Both jobs are inside their handler before either sends, then they resume interleaved.
    email.send = async (m) => {
      arrived++;
      if (arrived === 2) open();
      await barrier;
      await new Promise((r) => setTimeout(r, m.companyId === "c1" ? 10 : 0));
      seen.set(m.companyId ?? "none", currentTenant());
    };

    await Promise.all([
      t.h["email.send"]({ to: "a@x.io", subject: "s", text: "t", companyId: "c1", idempotencyKey: "ka" }),
      t.h["email.send"]({ to: "b@x.io", subject: "s", text: "t", companyId: "c2", idempotencyKey: "kb" }),
    ]);

    expect(seen.get("c1")).toBe("c1");
    expect(seen.get("c2")).toBe("c2");
  });
});

describe("the job table", () => {
  it("gives every declared job a handler, a function, and a bounded retry policy", () => {
    const t = harness();
    for (const name of Object.keys(JOBS) as JobName[]) {
      expect(typeof t.h[name], `${name} has a handler`).toBe("function");
      expect(JOBS[name].retryLimit, `${name} has a retry limit`).toBeGreaterThan(0);
      expect(JOBS[name].retryLimit, `${name} retry limit is bounded`).toBeLessThanOrEqual(5);
    }
  });
});
