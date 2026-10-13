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
  /** Extra events sent right after each `turn` event, computed from the persisted state. */
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

/** One thing to send the client. The transport decides how. */
export interface TurnEvent {
  event: string;
  data: unknown;
}

/**
 * Runs one interviewer turn and yields what the client should be told (contract 16).
 *
 * A generator rather than a function that writes to a socket, because there are now two transports
 * and only one turn. `runTurn` renders these as server-sent events for the ordinary text interview;
 * the live voice session consumes the same sequence over a WebSocket, speaking the `turn` events
 * aloud as they arrive. Splitting them would mean two copies of the turn lock, the status
 * transitions, the follow-up jobs and the error mapping, and the second copy would drift.
 *
 * Owns the session status transitions and schedules follow-up jobs. The turn lock is released when
 * the generator finishes, including when a consumer abandons it part-way.
 */
export async function* streamTurn(
  ctx: AppContext,
  sessionId: string,
  answer: UserAnswer | undefined,
  options?: RunTurnOptions,
): AsyncGenerator<TurnEvent, void> {
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

  const progress = (state: { coverage: Record<string, { status: string }> }): ProgressArea[] =>
    snapshot.template.coverageAreas.map((a) => ({
      key: a.key,
      name: a.name,
      status: state.coverage[a.key]?.status ?? "untouched",
    }));

  try {
    for (const item of options?.prelude ?? []) yield item;

    const gen = bundle.engine.nextTurn(snapshot, answer, bundle.settings);
    let next = await gen.next();
    let ended = false;
    while (!next.done) {
      const ev: EngineEvent = next.value;
      if (ev.type === "text") yield { event: "text", data: { delta: ev.text } };
      else if (ev.type === "turn") {
        ended = ev.turn.endInterview;
        yield {
          event: "turn",
          data: {
            message: ev.message,
            ended,
            progress: { areas: progress(ev.state) },
            // The live voice session speaks this; a text client ignores it. Carried on the turn
            // rather than fetched afterwards so speech can start before the next event arrives.
            ...(ev.turn.voiceShortForm ? { voiceShortForm: ev.turn.voiceShortForm } : {}),
            ...(ev.turn.widget ? { widget: ev.turn.widget } : {}),
          },
        };
        if (options?.afterTurn) {
          try {
            for (const extra of await options.afterTurn(ev.state)) yield extra;
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
      yield { event: "ended", data: { summaryAvailable: snapshot.template.endSummary } };
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
    const e = err as { code?: string; message?: string; name?: string; notified?: boolean };
    const code =
      e.name === "BudgetExceededError"
        ? "budget_exceeded"
        : e.name === "ProviderError"
          ? "provider_error"
          : "internal";
    ctx.log.error({ err, sessionId }, "turn failed");
    if (code === "budget_exceeded")
      await ctx.db.session.update({ where: { id: sessionId }, data: { status: "paused" } });
    yield {
      event: "error",
      data: {
        code,
        message:
          code === "budget_exceeded"
            ? budgetPausedMessage(e.notified === true)
            : code === "provider_error"
              ? "The assistant is temporarily unavailable. Your answer is saved; try again in a moment."
              : "Something went wrong. Your answer is saved.",
      },
    };
  } finally {
    // Runs when the consumer stops early too: a voice client that disconnects mid-turn must not
    // leave the session locked for two minutes.
    await ctx.db.session.updateMany({
      where: { id: sessionId, turnLockedAt: lockedAt },
      data: { turnLockedAt: null },
    });
  }
}

/**
 * Renders one turn as server-sent events (contract 16). The text interview's transport.
 */
export async function runTurn(
  ctx: AppContext,
  sessionId: string,
  answer: UserAnswer | undefined,
  reply: FastifyReply,
  options?: RunTurnOptions,
): Promise<void> {
  // The generator validates the session and takes the lock before yielding anything, so a refusal
  // is thrown here and rendered as JSON by the error handler. Writing the SSE head first would
  // turn every such refusal into a 200 with an error event, which a client cannot distinguish
  // from a turn that started and then failed.
  const stream = streamTurn(ctx, sessionId, answer, options);
  const first = await stream.next();

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (item: TurnEvent): void => {
    reply.raw.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
  };

  try {
    if (!first.done) {
      send(first.value);
      for await (const item of stream) send(item);
    }
  } finally {
    reply.raw.end();
  }
}

const TURN_LOCK_TTL_MS = 120_000;

/**
 * What a participant is told when a budget pauses the interview. The second sentence is only
 * allowed to say the organizer was notified when an alert actually reached someone (D-90):
 * `notified` comes from the alert router through the thrown error, and defaults to false.
 */
export function budgetPausedMessage(notified: boolean): string {
  return notified
    ? "This interview is paused because its budget is used up. Your answers are saved and the organizer has been notified."
    : "This interview is paused because its budget is used up. Your answers are saved; please contact the organizer.";
}
