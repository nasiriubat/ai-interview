import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withTenant } from "@aidp/db";
import { describeDb } from "@aidp/testing";
import type { FastifyReply } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { runTurn, TURN_LOCK_HEARTBEAT_MS, TURN_LOCK_TTL_MS } from "../src/modules/sessions/turn-runner.js";
import { parseSse, testWorld, TURN_MARKER, type TestWorld } from "./helpers.js";

/**
 * Turn lifecycle under failure (D-104): the stream ends in exactly one terminal event, a client
 * that leaves cancels the model call, and the turn lock is renewed while a turn runs.
 *
 * The model is a real HTTP server so cancellation is observable where it matters: the server sees
 * the connection close. The SSE side is a hand-built reply, because `inject` only returns when the
 * handler has finished and cannot disconnect part-way.
 */

type Plan = { kind: "hold" } | { kind: "reply"; text: string; delayMs?: number };

interface ModelServer {
  server: Server;
  url: string;
  next: Plan[];
  /** Resolves each time a request arrives, in order. */
  arrived: (() => void)[];
  closedByClient: number;
  requests: number;
}

async function modelServer(): Promise<ModelServer> {
  const state: ModelServer = {
    server: undefined as unknown as Server,
    url: "",
    next: [],
    arrived: [],
    closedByClient: 0,
    requests: 0,
  };
  state.server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      state.requests++;
      const plan = state.next.shift() ?? { kind: "reply", text: "Fine." };
      res.on("close", () => {
        if (!res.writableFinished) state.closedByClient++;
      });
      res.setHeader("content-type", "text/event-stream");
      const chunk = (text: string): void => {
        res.write(
          `data: ${JSON.stringify({ model: "fake-model", choices: [{ delta: { content: text } }] })}\n\n`,
        );
      };
      state.arrived.shift()?.();
      if (plan.kind === "hold") {
        chunk("Starting to say ");
        return; // never finishes; only the client closing ends it
      }
      setTimeout(() => {
        chunk(plan.text);
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 60 } })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
      }, plan.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => state.server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(state.server.address() as AddressInfo).port}/v1`;
  return state;
}

/** Just enough of a FastifyReply for `runTurn`: a raw response that records what is written. */
function fakeReply(opts: { failFirstWrite?: boolean } = {}) {
  const raw = Object.assign(new EventEmitter(), {
    chunks: [] as string[],
    writableEnded: false,
    destroyed: false,
    writes: 0,
    writeHead: () => raw,
    write(chunk: string) {
      raw.writes++;
      if (opts.failFirstWrite && raw.writes === 1) throw new Error("socket closed under us");
      raw.chunks.push(chunk);
      return true;
    },
    end() {
      raw.writableEnded = true;
    },
  });
  return { reply: { raw } as unknown as FastifyReply, raw };
}

const until = async (cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describeDb("turn runner: errors, disconnect, lock heartbeat", () => {
  let world: TestWorld;
  let model: ModelServer;
  let originalPublish: TestWorld["jobs"]["publish"];

  const newSession = async (): Promise<string> =>
    (
      await world.db.session.create({
        data: {
          companyId: world.companyId,
          templateId: world.templateId,
          status: "active",
          path: "nontechnical",
        },
      })
    ).id;
  /** The request path binds the tenant before anything runs; the test does the same. */
  const run = (
    sessionId: string,
    fastifyReply: FastifyReply,
    options?: Parameters<typeof runTurn>[4],
  ): Promise<void> =>
    withTenant(world.companyId, () => runTurn(world.ctx, sessionId, undefined, fastifyReply, options));
  const lockOf = async (id: string) =>
    (await world.db.session.findUniqueOrThrow({ where: { id } })).turnLockedAt;
  const arrival = (): Promise<void> =>
    new Promise((resolve) => {
      model.arrived.push(resolve);
    });

  beforeAll(async () => {
    model = await modelServer();
    world = await testWorld(model.url);
    originalPublish = world.jobs.publish.bind(world.jobs);
  });
  beforeEach(() => {
    model.next = [];
    model.arrived = [];
    model.closedByClient = 0;
    world.jobs.publish = originalPublish;
  });
  afterAll(async () => {
    await world.close();
    model.server.close();
  });

  const reply = (meta: object, text = "Tell me about your day."): string =>
    `${text}\n${TURN_MARKER}\n${JSON.stringify(meta)}`;

  it("renews several times within the TTL, so a live turn is not overtaken", () => {
    expect(TURN_LOCK_HEARTBEAT_MS * 5).toBe(TURN_LOCK_TTL_MS);
  });

  it("frees a session after a killed process within seconds, not a minute and a half (D-282)", () => {
    // Drill finding F3: `kill -9` of the API refused the participant for 82 s.
    expect(TURN_LOCK_TTL_MS).toBeLessThanOrEqual(15_000);
  });

  it("a client that disconnects mid-turn cancels the model call, releases the lock and is ledgered as aborted", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "hold" }];
    const seen = arrival();
    const { reply: fastifyReply, raw } = fakeReply();

    const done = run(sessionId, fastifyReply);
    await seen;
    raw.emit("close");
    await done;

    await until(() => model.closedByClient === 1);
    expect(await lockOf(sessionId)).toBeNull();
    const calls = await world.db.llmCall.findMany({ where: { sessionId } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: "interview_turn", status: "aborted" });
    // Estimated rather than zero: an abandoned stream is not free.
    expect(calls[0]!.inputTokens).toBeGreaterThan(0);
    // Nobody was listening, so nothing was written and no assistant message was stored.
    expect(raw.chunks.join("")).not.toContain("event: error");
    expect(await world.db.message.count({ where: { sessionId, role: "assistant" } })).toBe(0);
  });

  it("a failure writing to the socket ends the stream with one error event, and no turn follows it", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "reply", text: reply({ areaKey: "role" }) }];
    const { reply: fastifyReply, raw } = fakeReply({ failFirstWrite: true });

    await run(sessionId, fastifyReply);

    const events = parseSse(raw.chunks.join(""));
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(events[0]?.data).toMatchObject({ code: "internal" });
    expect(raw.writableEnded).toBe(true);
    expect(await lockOf(sessionId)).toBeNull();
  });

  it("a provider failure is one error event, then the stream ends", async () => {
    const sessionId = await newSession();
    // An empty reply plan cannot fail the provider; point the call at a closed port instead.
    const route = await world.db.route.findFirstOrThrow({
      where: { companyId: world.companyId, purpose: "interview_turn" },
    });
    const provider = await world.db.provider.findFirstOrThrow({ where: { id: route.providerId } });
    const original = provider.baseUrl;
    await world.db.provider.update({
      where: { id: provider.id },
      data: { baseUrl: "http://127.0.0.1:9/v1" },
    });
    world.ctx.callers.invalidateProvider(provider.id);
    const { reply: fastifyReply, raw } = fakeReply();

    try {
      await run(sessionId, fastifyReply);
    } finally {
      await world.db.provider.update({ where: { id: provider.id }, data: { baseUrl: original } });
      world.ctx.callers.invalidateProvider(provider.id);
    }

    const names = parseSse(raw.chunks.join("")).map((e) => e.event);
    expect(names.at(-1)).toBe("error");
    expect(names.filter((n) => n === "error")).toHaveLength(1);
    expect(names).not.toContain("ended");
    expect(await lockOf(sessionId)).toBeNull();
  });

  it("a queue failure after the interview ended does not contradict the stream with an error", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "reply", text: reply({ endInterview: true, areaKey: "closing" }, "Thank you.") }];
    world.jobs.publish = async () => {
      throw new Error("queue unreachable");
    };
    const { reply: fastifyReply, raw } = fakeReply();

    await run(sessionId, fastifyReply);

    const names = parseSse(raw.chunks.join("")).map((e) => e.event);
    expect(names.at(-1)).toBe("ended");
    expect(names).not.toContain("error");
    expect(await lockOf(sessionId)).toBeNull();
  });

  it("every stream ends in exactly one of turn, ended or error", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "reply", text: reply({ areaKey: "role" }) }];
    const { reply: fastifyReply, raw } = fakeReply();

    await run(sessionId, fastifyReply);

    const names = parseSse(raw.chunks.join("")).map((e) => e.event);

    const terminals = names.filter((n) => ["turn", "ended", "error"].includes(n));
    expect(terminals).toEqual(["turn"]);
    expect(names.at(-1)).toBe("turn");
  });

  it("renews the lock while a slow turn runs", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "reply", text: reply({ areaKey: "role" }), delayMs: 600 }];
    const seen = arrival();
    const { reply: fastifyReply } = fakeReply();

    const done = run(sessionId, fastifyReply, { heartbeatMs: 50 });
    await seen;
    const first = await lockOf(sessionId);
    await until(async () => {
      const now = await lockOf(sessionId);
      return now !== null && first !== null && now.getTime() > first.getTime();
    });
    await done;

    expect(await lockOf(sessionId)).toBeNull();
  });

  it("a turn whose lock was taken over stops quietly instead of running beside the new one", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "hold" }];
    const seen = arrival();
    const { reply: fastifyReply, raw } = fakeReply();

    const done = run(sessionId, fastifyReply, { heartbeatMs: 50 });
    await seen;
    // Someone else now holds the session: the token this turn renews no longer matches.
    await world.db.session.update({ where: { id: sessionId }, data: { turnLockedAt: new Date(1) } });
    await done;

    await until(() => model.closedByClient === 1);
    expect(raw.chunks.join("")).not.toContain("event: error");
    // The other holder's lock is not ours to release.
    expect((await lockOf(sessionId))?.getTime()).toBe(1);
  });

  it("admits a turn once the lock has outlived the TTL, and refuses one before", async () => {
    const sessionId = await newSession();
    const aged = (ms: number) => new Date(Date.now() - ms);

    await world.db.session.update({
      where: { id: sessionId },
      data: { turnLockedAt: aged(TURN_LOCK_TTL_MS / 2) },
    });
    await expect(run(sessionId, fakeReply().reply)).rejects.toThrow(/already in progress/);

    await world.db.session.update({
      where: { id: sessionId },
      data: { turnLockedAt: aged(TURN_LOCK_TTL_MS + 1_000) },
    });
    model.next = [{ kind: "reply", text: reply({ areaKey: "role" }) }];
    const { reply: fastifyReply, raw } = fakeReply();
    await run(sessionId, fastifyReply);
    expect(parseSse(raw.chunks.join("")).at(-1)?.event).toBe("turn");
  });

  // Last on purpose: the shutdown signal is one-way for the life of the context.
  it("tells a turn still streaming when the process drains to retry, with a shutting_down error", async () => {
    const sessionId = await newSession();
    model.next = [{ kind: "hold" }];
    const seen = arrival();
    const { reply: fastifyReply, raw } = fakeReply();

    const done = run(sessionId, fastifyReply);
    await seen;
    world.ctx.shutdown.abort();
    await done;

    const events = parseSse(raw.chunks.join(""));
    expect(events.map((e) => e.event)).toEqual(["error"]);
    expect(events[0]?.data).toMatchObject({ code: "shutting_down" });
    await until(() => model.closedByClient === 1);
    expect(await lockOf(sessionId)).toBeNull();
  });
});
