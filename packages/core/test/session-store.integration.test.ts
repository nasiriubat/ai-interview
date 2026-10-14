import { SessionStateSchema } from "@aidp/shared";
import { describeDb } from "@aidp/testing";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PrismaSessionStore, requestFinish } from "../src/sessions/prisma-store.js";

/**
 * The Postgres half of the extraction contract (D-100). The in-memory store proves the logic; this
 * proves the SQL: the compare-and-set really serializes concurrent runs, the three writes really
 * share a transaction, and a whole-state write from a stale turn cannot move the cursors back.
 */
describeDb("PrismaSessionStore extraction commit", () => {
  const db = new PrismaClient();
  const store = new PrismaSessionStore(db);
  const suffix = `ss_${Date.now().toString(36)}`;
  let companyId = "";
  let templateId = "";

  const task = (name: string) => ({
    kind: "task" as const,
    name,
    frequency: "daily" as const,
    minutesPerOccurrence: 5,
    tools: [],
    painScore: 1,
  });
  const commit = (fromSeq: number, toSeq: number, names: string[], company = companyId) => ({
    companyId: company,
    fromSeq,
    toSeq,
    facts: names.map(task),
    extractorVersion: "extraction@1",
    event: { count: names.length, upToSeq: toSeq, promptVersion: "extraction@1" },
  });
  const newSession = async (state: object = {}, status = "active"): Promise<string> =>
    (await db.session.create({ data: { companyId, templateId, status, state } })).id;
  const stateOf = async (id: string) =>
    (await db.session.findUniqueOrThrow({ where: { id } })).state as {
      facts?: { name: string }[];
      lastExtractedSeq?: number;
      summaryUpToSeq?: number;
      turnCount?: number;
    };

  beforeAll(async () => {
    companyId = (await db.company.create({ data: { name: `Store ${suffix}` } })).id;
    templateId = (
      await db.interviewTemplate.create({
        data: { companyId, key: `k-${suffix}`, name: "T", objective: "o", privacyMode: "anonymous" },
      })
    ).id;
  });

  afterAll(async () => {
    await db.fact.deleteMany({ where: { companyId } });
    const ids = (await db.session.findMany({ where: { companyId }, select: { id: true } })).map((s) => s.id);
    await db.sessionEvent.deleteMany({ where: { sessionId: { in: ids } } });
    await db.session.deleteMany({ where: { companyId } });
    await db.interviewTemplate.deleteMany({ where: { companyId } });
    await db.company.delete({ where: { id: companyId } });
    await db.$disconnect();
  });

  it("commits state, rows and event together, and the same batch twice writes the rows once", async () => {
    const id = await newSession();

    expect(await store.commitExtraction(id, commit(0, 24, ["a", "b"]))).toBe("committed");
    expect(await store.commitExtraction(id, commit(0, 24, ["a", "b"]))).toBe("stale");

    const state = await stateOf(id);
    expect(state.lastExtractedSeq).toBe(24);
    expect(state.facts?.map((f) => f.name)).toEqual(["a", "b"]);
    const rows = await db.fact.findMany({ where: { sessionId: id }, orderBy: { ordinal: "asc" } });
    expect(rows.map((r) => [r.batchEndSeq, r.ordinal, r.extractorVersion])).toEqual([
      [24, 0, "extraction@1"],
      [24, 1, "extraction@1"],
    ]);
    expect(await db.sessionEvent.count({ where: { sessionId: id, type: "facts_extracted" } })).toBe(1);
  });

  it("appends events from concurrent writers without colliding on seq (a turn beside an extraction)", async () => {
    const id = await newSession();
    // The shape of the production race: the API's turn events and the worker's extraction commits
    // land on one session at the same moment. Before the row lock, some of these threw the
    // (sessionId, seq) unique constraint and failed the participant's turn.
    const writers = [
      ...Array.from({ length: 12 }, (_, i) => store.appendEvent(id, "state_delta", { n: i })),
      ...Array.from({ length: 6 }, (_, i) =>
        store.commitExtraction(id, commit(i * 24, (i + 1) * 24, [`c${i}`])),
      ),
    ];
    const settled = await Promise.allSettled(writers);
    expect(settled.filter((s) => s.status === "rejected")).toEqual([]);
    const seqs = (await db.sessionEvent.findMany({ where: { sessionId: id }, orderBy: { seq: "asc" } })).map(
      (e) => e.seq,
    );
    expect(seqs.length).toBeGreaterThanOrEqual(12);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it("two overlapping runs from the same cursor: exactly one commits", async () => {
    const id = await newSession();

    const results = await Promise.all([
      store.commitExtraction(id, commit(0, 24, ["a"])),
      store.commitExtraction(id, commit(0, 24, ["a"])),
      store.commitExtraction(id, commit(0, 24, ["a"])),
    ]);

    expect(results.filter((r) => r === "committed")).toHaveLength(1);
    expect(await db.fact.count({ where: { sessionId: id } })).toBe(1);
    expect((await stateOf(id)).facts).toHaveLength(1);
  });

  it("a failure after the state patch rolls the state back (no cursor past facts nobody wrote)", async () => {
    const id = await newSession();

    // The state is patched first; the fact insert then violates the company foreign key.
    await expect(store.commitExtraction(id, commit(0, 24, ["a"], "no-such-company"))).rejects.toThrow();

    const state = await stateOf(id);
    expect(state.lastExtractedSeq ?? 0).toBe(0);
    expect(state.facts ?? []).toHaveLength(0);
    expect(await db.sessionEvent.count({ where: { sessionId: id } })).toBe(0);
    // And the retry commits normally.
    expect(await store.commitExtraction(id, commit(0, 24, ["a"]))).toBe("committed");
  });

  it("does not write facts into a deleted session", async () => {
    const id = await newSession({}, "deleted");

    expect(await store.commitExtraction(id, commit(0, 24, ["a"]))).toBe("stale");
    expect(await db.fact.count({ where: { sessionId: id } })).toBe(0);
  });

  it("a whole-state write from a turn that started earlier cannot move the cursors backwards", async () => {
    const id = await newSession();
    await store.commitExtraction(id, commit(0, 24, ["a"]));
    await store.commitSummary(id, "folded", 10);

    // The turn loaded its snapshot before both jobs ran: cursors at zero, no facts.
    await store.saveState(id, {
      ...SessionStateSchema.parse({}),
      lastExtractedSeq: 0,
      summaryUpToSeq: 0,
      facts: [],
      turnCount: 7,
    });

    const state = await stateOf(id);
    expect(state.lastExtractedSeq).toBe(24);
    expect(state.summaryUpToSeq).toBe(10);
    expect(state.facts?.map((f) => f.name)).toEqual(["a"]);
    expect(state.turnCount).toBe(7);
  });

  it("the summary job patches only its own keys: turn progress made meanwhile survives", async () => {
    const id = await newSession({ turnCount: 9, coverage: { x: { status: "covered", known: "k" } } });

    await store.commitSummary(id, "a summary", 12);

    const row = await db.session.findUniqueOrThrow({ where: { id } });
    expect(row.summary).toBe("a summary");
    const state = row.state as { turnCount: number; summaryUpToSeq: number; coverage: object };
    expect(state).toMatchObject({ turnCount: 9, summaryUpToSeq: 12 });
    expect(state.coverage).toHaveProperty("x");
  });

  it("rejects a second row with the same batch key even without the compare-and-set", async () => {
    const id = await newSession();
    const data = {
      companyId,
      sessionId: id,
      kind: "task",
      payload: {},
      extractorVersion: "extraction@1",
      batchEndSeq: 24,
      ordinal: 0,
    };
    await db.fact.create({ data });

    await expect(db.fact.create({ data })).rejects.toThrow(/Unique constraint/);
  });

  it("stores the interview's language on each fact row (D-177)", async () => {
    const id = await newSession();
    await store.commitExtraction(id, { ...commit(0, 24, ["a", "b"]), language: "fi" });
    const rows = await db.fact.findMany({ where: { sessionId: id } });
    expect(rows.map((r) => r.language)).toEqual(["fi", "fi"]);
  });

  it("flags a session once: the first reason stays, later flags are events only (D-173)", async () => {
    const id = await newSession();
    await store.appendEvent(id, "flag", { reason: "the participant sounds distressed" });
    await store.appendEvent(id, "flag", { reason: "a second, later reason" });

    const row = await db.session.findUniqueOrThrow({ where: { id } });
    expect(row.flagged).toBe(true);
    expect(row.flagReason).toBe("the participant sounds distressed");
    expect(row.flaggedAt).not.toBeNull();
    expect(row.flagAckedAt).toBeNull();
    expect(await db.sessionEvent.count({ where: { sessionId: id, type: "flag" } })).toBe(2);
  });

  it("requestFinish patches one key and leaves the turn count and the cursors alone (D-170)", async () => {
    const id = await newSession({
      turnCount: 7,
      lastExtractedSeq: 4,
      coverage: { x: { status: "partial" } },
    });
    await requestFinish(db, id);

    const state = (await db.session.findUniqueOrThrow({ where: { id } })).state as Record<string, unknown>;
    expect(state).toMatchObject({ finishRequested: true, turnCount: 7, lastExtractedSeq: 4 });
    expect(SessionStateSchema.parse(state).finishRequested).toBe(true);
  });

  it("does not request a finish on a completed session", async () => {
    const id = await newSession({ turnCount: 7 }, "completed");
    await requestFinish(db, id);
    const state = (await db.session.findUniqueOrThrow({ where: { id } })).state as Record<string, unknown>;
    expect(state.finishRequested).toBeUndefined();
  });
});
