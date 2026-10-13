import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Heartbeat } from "../src/heartbeat.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function setup(): Promise<{ file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "heartbeat-"));
  dirs.push(dir);
  // Nested on purpose: the volume is mounted before the directory under it exists.
  return { file: join(dir, "heartbeat", "worker") };
}

const mtime = async (file: string): Promise<number> => (await stat(file)).mtimeMs;
const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("worker heartbeat", () => {
  it("writes the file when the queue answers", async () => {
    const { file } = await setup();
    const hb = new Heartbeat({ file, probe: async () => 1, onFatal: () => undefined });
    expect(await hb.beat()).toBe("ok");
    expect(await exists(file)).toBe(true);
  });

  it("leaves the file alone while the queue does not answer, so the healthcheck goes stale", async () => {
    const { file } = await setup();
    let up = true;
    const hb = new Heartbeat({
      file,
      probe: async () => {
        if (!up) throw new Error("connection refused");
      },
      maxFailures: 10,
      onFatal: () => undefined,
    });
    await hb.beat();
    // Age the file, then fail a beat: it must stay old.
    const old = new Date(Date.now() - 600_000);
    await utimes(file, old, old);
    up = false;
    expect(await hb.beat()).toBe("failed");
    expect(Math.abs((await mtime(file)) - old.getTime())).toBeLessThan(2000);

    up = true;
    await hb.beat();
    expect(await mtime(file)).toBeGreaterThan(old.getTime() + 60_000);
  });

  it("asks to be restarted after three consecutive failures, once", async () => {
    const { file } = await setup();
    const fatal: string[] = [];
    const hb = new Heartbeat({
      file,
      probe: async () => {
        throw new Error("db down");
      },
      onFatal: (reason) => fatal.push(reason),
    });
    expect(await hb.beat()).toBe("failed");
    expect(await hb.beat()).toBe("failed");
    expect(fatal).toHaveLength(0);
    expect(await hb.beat()).toBe("fatal");
    expect(fatal).toEqual(["pg-boss unreachable for 3 consecutive checks"]);
    await hb.beat();
    expect(fatal).toHaveLength(1);
  });

  it("counts failures that are consecutive, not total", async () => {
    const { file } = await setup();
    const script = [false, false, true, false, false, true];
    const fatal: string[] = [];
    const hb = new Heartbeat({
      file,
      probe: async () => {
        if (!script.shift()) throw new Error("flaky");
      },
      onFatal: (r) => fatal.push(r),
    });
    for (let i = 0; i < 6; i++) await hb.beat();
    expect(fatal).toHaveLength(0);
  });

  it("treats a probe that hangs as a failure", async () => {
    const { file } = await setup();
    const hb = new Heartbeat({
      file,
      probe: () => new Promise(() => undefined),
      probeTimeoutMs: 20,
      maxFailures: 1,
      onFatal: () => undefined,
    });
    expect(await hb.beat()).toBe("fatal");
    expect(await exists(file)).toBe(false);
  });
});
