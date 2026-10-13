import { CallAbortedError, type EngineEvent, type UserAnswer } from "@aidp/ai";
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
  /**
   * Cancels the turn: the SSE transport sets it when the client disconnects, the live voice
   * session when its socket closes or the participant barges in. It reaches the model request, so
   * the call stops and is recorded as aborted instead of being billed in full.
   */
  signal?: AbortSignal;
  /** How often the turn lock is renewed while the turn runs. A test seam; production uses the default. */
  heartbeatMs?: number;
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

  // One turn at a time per session (double taps, retries, dev double-mounts). A lock that has not
  // been renewed within the TTL belongs to a process that died, and is taken over.
  const firstLockedAt = new Date();
  const locked = await ctx.db.session.updateMany({
    where: {
      id: sessionId,
      OR: [
        { turnLockedAt: null },
        { turnLockedAt: { lt: new Date(firstLockedAt.getTime() - TURN_LOCK_TTL_MS) } },
      ],
    },
    data: { turnLockedAt: firstLockedAt },
  });
  if (locked.count === 0) throw new AppError("conflict", "A turn is already in progress for this session");

  // From here the lock is ours and must be released on every path out, including a failure while
  // loading what the turn needs; so the heartbeat starts now and everything else is inside try.
  const lock = { token: firstLockedAt, lost: false };
  const abort = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let beating: Promise<void> | undefined;
  const beat = async (): Promise<void> => {
    const next = new Date();
    try {
      const renewed = await ctx.db.session.updateMany({
        where: { id: sessionId, turnLockedAt: lock.token },
        data: { turnLockedAt: next },
      });
      if (renewed.count === 0) {
        // Someone else holds the session now (the lock was taken over, or the row was reset).
        // Carrying on would run two turns at once, so this one stops.
        lock.lost = true;
        abort.abort();
        return;
      }
      lock.token = next;
    } catch (err) {
      // A database blip must not kill a healthy turn; the next beat tries again, and the lock has
      // two missed beats of slack before anyone may take it.
      ctx.log.warn({ err, sessionId }, "turn lock heartbeat failed");
    }
  };
  const heartbeat = setInterval(() => {
    beating = beat();
  }, options?.heartbeatMs ?? TURN_LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  try {
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

      const gen = bundle.engine.nextTurn(snapshot, answer, bundle.settings, { signal });
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
      // Outside the error path on purpose. By now the turn is persisted and the client has been told
      // so (`turn`, and `ended` when it was the last). A queue that is briefly unreachable must not
      // turn that into an `error` event after the fact, which would contradict the stream. The jobs
      // are idempotent and the next turn's follow-up trigger schedules them again.
      for (const [name, due] of [
        ["session.summarize", result.followUps.summarize],
        ["session.extract", result.followUps.extract],
      ] as const) {
        if (!due) continue;
        try {
          await ctx.jobs.publish(
            name,
            { sessionId, companyId: row.companyId },
            { singletonKey: `${name === "session.summarize" ? "summarize" : "extract"}:${sessionId}` },
          );
        } catch (err) {
          ctx.log.error({ err, sessionId, job: name }, "could not queue a follow-up job");
        }
      }
    } catch (err) {
      // The caller left (client disconnect, socket closed, barge-in) or the lock was lost: nobody
      // is listening, so there is nothing to tell. The participant's own message is already stored;
      // the lock is released below.
      if (signal.aborted || err instanceof CallAbortedError) {
        ctx.log.info(
          { sessionId, reason: lock.lost ? "turn_lock_lost" : "caller_gone" },
          "turn aborted before it finished",
        );
        return;
      }
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
      yield {
        event: "error",
        data: {
          code,
          message:
            code === "budget_exceeded"
              ? "This interview is paused because the budget is exhausted. The organizer has been notified."
              : code === "provider_error"
                ? "The assistant is temporarily unavailable. Your answer is saved; try again in a moment."
                : "Something went wrong. Your answer is saved.",
        },
      };
    }
  } finally {
    // Runs when the consumer stops early too: a voice client that disconnects mid-turn must not
    // leave the session locked for the whole TTL. The in-flight beat settles first, so it cannot
    // renew the lock after it has been released.
    clearInterval(heartbeat);
    await beating;
    abort.abort();
    await ctx.db.session.updateMany({
      where: { id: sessionId, turnLockedAt: lock.token },
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
  // A client that goes away must stop the turn, not just stop reading it: the model call would
  // otherwise run to completion and be paid for.
  const gone = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) gone.abort();
  };
  reply.raw.on("close", onClose);
  const signal = AbortSignal.any([
    gone.signal,
    ctx.shutdown.signal,
    ...(options?.signal ? [options.signal] : []),
  ]);
  const stream = streamTurn(ctx, sessionId, answer, { ...options, signal });
  let first: IteratorResult<TurnEvent, void>;
  try {
    first = await stream.next();
  } catch (err) {
    reply.raw.off("close", onClose);
    throw err;
  }

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (item: TurnEvent): void => {
    reply.raw.write(`event: ${item.event}\ndata: ${JSON.stringify(item.data)}\n\n`);
  };

  // Whether the client has been told how this turn ended. A turn aborted by the process draining
  // has not, and must be told to retry rather than left with a stream that just stops.
  let concluded = false;
  const sendTracked = (item: TurnEvent): void => {
    send(item);
    if (item.event === "turn" || item.event === "ended" || item.event === "error") concluded = true;
  };
  try {
    if (!first.done) {
      sendTracked(first.value);
      for await (const item of stream) sendTracked(item);
    }
    if (!concluded && ctx.shutdown.signal.aborted && !gone.signal.aborted) {
      send({
        event: "error",
        data: {
          code: "shutting_down",
          message: "The service is restarting. Your answer is saved; try again in a moment.",
        },
      });
    }
  } catch (err) {
    // The generator reports its own failures as an `error` event. What reaches here is the
    // transport failing (a write to a socket that just closed, a payload that will not
    // serialize): log it, and tell the client if there is still anyone to tell. Leaving the
    // for-await closes the generator, which releases the turn lock.
    ctx.log.error({ err, sessionId }, "turn stream failed while writing");
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      try {
        send({
          event: "error",
          data: { code: "internal", message: "Something went wrong. Your answer is saved." },
        });
      } catch {
        // The connection is gone; nothing more can be said.
      }
    }
  } finally {
    reply.raw.off("close", onClose);
    // Reading may have stopped before the generator finished (a write failed on the first event,
    // before any `for await` was entered). Closing it here is what runs its `finally` and releases
    // the turn lock; without it the session stayed locked until the TTL.
    await stream.return(undefined).catch((err: unknown) => {
      ctx.log.warn({ err, sessionId }, "could not close the turn stream");
    });
    reply.raw.end();
  }
}

/**
 * The turn lock is renewed every 30 s and expires after 90 s, three missed beats. A turn that runs
 * long (a slow model, retries) keeps its lock; a process that died frees the session in 90 s
 * rather than the 120 s a fixed lock took, and a live turn can no longer be overtaken by a second.
 */
export const TURN_LOCK_HEARTBEAT_MS = 30_000;
export const TURN_LOCK_TTL_MS = 90_000;
