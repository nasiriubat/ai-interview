import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdown, type ShutdownDeps } from "../src/shutdown.js";

describe("worker shutdown", () => {
  const events: string[] = [];
  const logged: { level: string; message: string; meta: Record<string, unknown> }[] = [];

  const build = (over: Partial<ShutdownDeps> = {}) =>
    createShutdown({
      stopJobs: async () => {
        events.push("stopped");
      },
      disconnect: async () => {
        events.push("disconnected");
      },
      inFlight: () => ["analysis.run:j1"],
      exit: (code) => {
        events.push(`exit ${code}`);
      },
      graceMs: 25_000,
      log: {
        info: (meta, message) => logged.push({ level: "info", message, meta }),
        warn: (meta, message) => logged.push({ level: "warn", message, meta }),
        error: (meta, message) => logged.push({ level: "error", message, meta }),
      },
      ...over,
    });

  beforeEach(() => {
    events.length = 0;
    logged.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drains, disconnects, and exits 0 only after a clean stop", async () => {
    const shutdown = build();

    await shutdown("SIGTERM");

    expect(events).toEqual(["stopped", "disconnected", "exit 0"]);
  });

  it("gives the queue the configured grace period", async () => {
    const stopJobs = vi.fn(async () => undefined);
    const shutdown = build({ stopJobs, graceMs: 7_000 });

    await shutdown("SIGTERM");

    expect(stopJobs).toHaveBeenCalledWith(7_000);
  });

  it("exits 1 and names what was running when the deadline passes", async () => {
    const shutdown = build({ stopJobs: () => new Promise<void>(() => undefined) });

    const done = shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(25_000 + 2_000);
    await done;

    expect(events).toEqual(["exit 1"]);
    const err = logged.find((l) => l.level === "error");
    expect(err?.message).toMatch(/still running at the shutdown deadline/);
    expect(err?.meta).toMatchObject({ inFlight: ["analysis.run:j1"] });
  });

  it("exits 1 immediately on a second signal, without waiting for the first to finish", async () => {
    const shutdown = build({ stopJobs: () => new Promise<void>(() => undefined) });

    void shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(events).toEqual(["exit 1"]);
    expect(logged.some((l) => l.message.includes("second signal"))).toBe(true);
  });

  it("does not report success when stopping the queue failed", async () => {
    const shutdown = build({
      stopJobs: async () => {
        throw new Error("connection lost");
      },
    });

    await shutdown("SIGTERM");

    expect(events).toEqual(["exit 1"]);
    expect(events).not.toContain("disconnected");
  });

  it("does not report success when the database will not disconnect", async () => {
    const shutdown = build({
      disconnect: async () => {
        throw new Error("pool stuck");
      },
    });

    await shutdown("SIGTERM");

    expect(events).toEqual(["stopped", "exit 1"]);
  });
});
