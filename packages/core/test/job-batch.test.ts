import { describe, expect, it } from "vitest";
import { BossJobs, runBatch } from "../src/jobs/pg-boss.js";

const job = (id: string, data: unknown = { sessionId: id, companyId: "c1" }) => ({ id, data });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runBatch (plan 1.8)", () => {
  it("settles each job on its own: a throw fails that job alone and the others complete", async () => {
    const ran: string[] = [];
    const errors: string[] = [];

    const results = await runBatch(
      "session.extract",
      [job("j1"), job("j2"), job("j3")],
      async (p) => {
        ran.push(p.sessionId);
        if (p.sessionId === "j2") throw new Error("boom");
      },
      { onError: (id) => errors.push(id) },
    );

    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["j1", "completed"],
      ["j2", "failed"],
      ["j3", "completed"],
    ]);
    expect(ran.sort()).toEqual(["j1", "j2", "j3"]);
    expect(errors).toEqual(["j2"]);
    expect(results[1]?.output).toEqual({ message: "boom" });
  });

  it("runs the jobs in parallel: wall time is the longest job, not the sum", async () => {
    const started = Date.now();

    await runBatch("session.extract", [job("a"), job("b"), job("c")], async () => {
      await sleep(80);
    });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(200);
  });

  it("sends a payload that cannot parse straight to the dead-letter queue, without calling the handler", async () => {
    let called = false;
    const errors: unknown[] = [];

    const results = await runBatch(
      "session.extract",
      [job("bad", { nope: true })],
      async () => {
        called = true;
      },
      { onError: (_id, e) => errors.push(e) },
    );

    expect(results[0]).toMatchObject({ id: "bad", status: "deadletter" });
    expect(called).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it("hands the job's abort signal to the handler and reports start and settle for the shutdown log", async () => {
    const ac = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const trace: string[] = [];

    await runBatch(
      "session.extract",
      [{ ...job("j1"), signal: ac.signal }],
      async (_p, _id, signal) => {
        seen.push(signal);
      },
      { onStart: (id) => trace.push(`start ${id}`), onSettle: (id) => trace.push(`settle ${id}`) },
    );

    expect(seen[0]).toBe(ac.signal);
    expect(trace).toEqual(["start j1", "settle j1"]);
  });
});

describe("BossJobs.consume", () => {
  it("registers a batch worker that settles per job, and tracks what is in flight", async () => {
    const jobs = new BossJobs("postgresql://unused");
    const registered: {
      name: string;
      options: Record<string, unknown>;
      handler: (j: unknown[]) => unknown;
    }[] = [];
    (jobs.boss as unknown as { work: unknown }).work = async (
      name: string,
      options: Record<string, unknown>,
      handler: (j: unknown[]) => unknown,
    ) => {
      registered.push({ name, options, handler });
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    await jobs.consume("session.extract", async () => gate, 3);

    expect(registered[0]).toMatchObject({
      name: "session.extract",
      options: { batchSize: 3, perJobResults: true },
    });
    const running = registered[0]!.handler([job("j1"), job("j2")]) as Promise<{ status: string }[]>;
    await sleep(5);
    expect(jobs.inFlight().sort()).toEqual(["session.extract:j1", "session.extract:j2"]);
    release();
    expect((await running).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(jobs.inFlight()).toEqual([]);
  });
});
