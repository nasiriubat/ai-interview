import type { EngineEvent, UserAnswer } from "@aidp/ai";
import type { SessionState } from "@aidp/shared";
import type { FastifyReply } from "fastify";
import type { AppContext } from "../../context.js";
import { AppError } from "../../lib/errors.js";

export interface ProgressArea {
  key: string;
  name: string;
  status: string;
}

export interface RunTurnOptions {
  /** Extra SSE events sent right after each `turn` event, computed from the persisted state. */
  afterTurn?: (state: SessionState) => Promise<{ event: string; data: unknown }[]>;
  /**
   * Events sent before the turn begins.
   *
   * This exists for recorded voice (FR-30). A typed answer is already on the participant's screen
   * before the request is made, so the stream never echoes it back. A spoken answer is not: the
   * text is produced by transcription on this side, and without an echo the participant watches
   * the interviewer reply to something they cannot see themselves having said, until a reload.
   */
  prelude?: { event: string; data: unknown }[];
}

/**
 * Runs one interviewer turn for a session and streams it as SSE (contract 16).
 * Owns the session status transitions and schedules follow-up jobs.
 */
export async function runTurn(
  ctx: AppContext,
  sessionId: string,
  answer: UserAnswer | undefined,
  reply: FastifyReply,
  options?: RunTurnOptions,
): Promise<void> {
  const row = await ctx.db.session.findUniqueOrThrow({ where: { id: sessionId } });
  if (row.status === "deleted" || row.status === "completed")
    throw new AppError("conflict", `Session is ${row.status}`);
  if (row.status === "created") throw new AppError("conflict", "Consent is required before the first turn");

  // One turn at a time per session (double taps, retries, dev double-mounts). Stale locks expire.
  const lockedAt = new Date();
  const locked = await ctx.db.session.updateMany({
    where: {
      id: sessionId,
      OR: [{ turnLockedAt: null }, { turnLockedAt: { lt: new Date(lockedAt.getTime() - TURN_LOCK_TTL_MS) } }],
    },
    data: { turnLockedAt: lockedAt },
  });
  if (locked.count === 0) throw new AppError("conflict", "A turn is already in progress for this session");

  const chain = [
    ...(row.campaignId ? [{ scope: "campaign" as const, scopeId: row.campaignId }] : []),
    { scope: "template" as const, scopeId: row.templateId },
    { scope: "tenant" as const, scopeId: row.companyId },
  ];
  const bundle = await ctx.engines.forSession(row.companyId, chain, sessionId);
  const snapshot = await bundle.store.snapshot(sessionId);
  if (row.campaignId) {
    const campaign = await ctx.db.campaign.findUniqueOrThrow({
      where: { id: row.campaignId },
      select: { maxTurns: true },
    });
    bundle.settings.maxTurns = Math.min(bundle.settings.maxTurns, campaign.maxTurns);
  }
  if (row.status !== "active")
    await ctx.db.session.update({
      where: { id: sessionId },
      data: { status: "active", startedAt: row.startedAt ?? new Date() },
    });

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (event: string, data: unknown): void => {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  for (const item of options?.prelude ?? []) send(item.event, item.data);
  const progress = (state: { coverage: Record<string, { status: string }> }): ProgressArea[] =>
    snapshot.template.coverageAreas.map((a) => ({
      key: a.key,
      name: a.name,
      status: state.coverage[a.key]?.status ?? "untouched",
    }));

  try {
    const gen = bundle.engine.nextTurn(snapshot, answer, bundle.settings);
    let next = await gen.next();
    let ended = false;
    while (!next.done) {
      const ev: EngineEvent = next.value;
      if (ev.type === "text") send("text", { delta: ev.text });
      else if (ev.type === "turn") {
        ended = ev.turn.endInterview;
        send("turn", { message: ev.message, ended, progress: { areas: progress(ev.state) } });
        if (options?.afterTurn) {
          try {
            for (const extra of await options.afterTurn(ev.state)) send(extra.event, extra.data);
          } catch (err) {
            ctx.log.warn({ err, sessionId }, "after-turn events failed");
          }
        }
      } else {
        ended = true;
      }
      next = await gen.next();
    }
    const result = next.value;
    if (result.ended) {
      await ctx.db.session.update({
        where: { id: sessionId },
        data: { status: "completed", endedAt: new Date() },
      });
      send("ended", { summaryAvailable: snapshot.template.endSummary });
      if (row.campaignId && snapshot.template.analysisEnabled) {
        await ctx.analysis.maybeQueueForCampaign(row.companyId, row.campaignId).catch((err: unknown) => {
          ctx.log.warn({ err, sessionId }, "could not queue analysis");
        });
      }
    }
    if (result.followUps.summarize)
      await ctx.jobs.publish(
        "session.summarize",
        { sessionId, companyId: row.companyId },
        { singletonKey: `summarize:${sessionId}` },
      );
    if (result.followUps.extract)
      await ctx.jobs.publish(
        "session.extract",
        { sessionId, companyId: row.companyId },
        { singletonKey: `extract:${sessionId}` },
      );
  } catch (err) {
    const e = err as { code?: string; message?: string; name?: string };
    const code =
      e.name === "BudgetExceededError"
        ? "budget_exceeded"
        : e.name === "ProviderError"
          ? "provider_error"
          : "internal";
    ctx.log.error({ err, sessionId }, "turn failed");
    if (code === "budget_exceeded")
      await ctx.db.session.update({ where: { id: sessionId }, data: { status: "paused" } });
    send("error", {
      code,
      message:
        code === "budget_exceeded"
          ? "This interview is paused because the budget is exhausted. The organizer has been notified."
          : code === "provider_error"
            ? "The assistant is temporarily unavailable. Your answer is saved; try again in a moment."
            : "Something went wrong. Your answer is saved.",
    });
  } finally {
    await ctx.db.session.updateMany({
      where: { id: sessionId, turnLockedAt: lockedAt },
      data: { turnLockedAt: null },
    });
    reply.raw.end();
  }
}

const TURN_LOCK_TTL_MS = 120_000;
