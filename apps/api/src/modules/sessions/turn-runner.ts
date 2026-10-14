import { CallAbortedError, type EngineEvent, type TurnAnswer } from "@aidp/ai";
import type { SessionState } from "@aidp/shared";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import type { FastifyReply } from "fastify";
import type { RouteContext } from "../../context.js";
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

const tracer = trace.getTracer("aidp.api");

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
  ctx: RouteContext,
  sessionId: string,
  answer: TurnAnswer | undefined,
  options?: RunTurnOptions,
): AsyncGenerator<TurnEvent, void> {
  // The `session.turn` span (D-222): the model calls the turn makes are its children, and the
  // follow-up jobs it queues carry its trace context. It has to be re-entered on every `next()`
  // because a generator resumes in its consumer's async context, not in the one that started it.
  const mode: "chat" | "voice" =
    answer && "modality" in answer && answer.modality === "voice" ? "voice" : "chat";
  const span = tracer.startSpan("session.turn", {
    attributes: { "session.id": sessionId, "turn.mode": mode },
  });
  const spanContext = trace.setSpan(context.active(), span);
  const began = Date.now();
  let tenant = "";
  let firstTokenMs: number | undefined;
  let ended = false;
  let failed: string | undefined;
  const inner = streamTurnInner(ctx, sessionId, answer, options, (companyId) => {
    tenant = companyId;
    span.setAttribute("tenant.id", companyId);
  });
  try {
    for (;;) {
      const r = await context.with(spanContext, () => inner.next());
      if (r.done) return;
      const item = r.value;
      if (firstTokenMs === undefined && (item.event === "text" || item.event === "turn")) {
        firstTokenMs = Date.now() - began;
        span.setAttribute("turn.first_token_ms", firstTokenMs);
      }
      if (item.event === "ended") ended = true;
      if (item.event === "error") failed = String((item.data as { code?: string }).code ?? "error");
      yield item;
    }
  } finally {
    await inner.return(undefined);
    span.setAttribute("turn.ended", ended);
    if (failed) {
      span.setAttribute("turn.error", failed);
      span.setStatus({ code: SpanStatusCode.ERROR, message: failed });
    }
    span.end();
    if (tenant) ctx.metrics.turn(tenant, mode, Date.now() - began);
  }
}

async function* streamTurnInner(
  ctx: RouteContext,
  sessionId: string,
  answer: TurnAnswer | undefined,
  options: RunTurnOptions | undefined,
  onLoaded: (companyId: string) => void,
): AsyncGenerator<TurnEvent, void> {
  const turns = ctx.services.turns;
  const row = await turns.load(sessionId);
  onLoaded(row.companyId);
  if (row.status === "deleted" || row.status === "completed")
    throw new AppError("conflict", `Session is ${row.status}`);
  if (row.status === "created") throw new AppError("conflict", "Consent is required before the first turn");

  // One turn at a time per session (double taps, retries, dev double-mounts). A lock that has not
  // been renewed within the TTL belongs to a process that died, and is taken over.
  const firstLockedAt = new Date();
  const locked = await turns.acquireLock(row.companyId, sessionId, firstLockedAt, TURN_LOCK_TTL_MS);
  if (!locked) throw new AppError("conflict", "A turn is already in progress for this session");

  // From here the lock is ours and must be released on every path out, including a failure while
  // loading what the turn needs; so the heartbeat starts now and everything else is inside try.
  const lock = { token: firstLockedAt, lost: false };
  const abort = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let beating: Promise<void> | undefined;
  const beat = async (): Promise<void> => {
    const next = new Date();
    try {
      const renewed = await turns.renewLock(row.companyId, sessionId, lock.token, next);
      if (!renewed) {
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
    // A control names an area of this interview's template. An unknown one is a malformed request,
    // not something to skip over quietly, so it is refused before the turn takes any state.
    if (answer && "control" in answer && answer.control.type !== "finish") {
      const wanted = answer.control.areaKey;
      if (!snapshot.template.coverageAreas.some((a) => a.key === wanted))
        throw new AppError("validation", "Unknown interview area");
    }
    if (row.campaignId) {
      const maxTurns = await turns.campaignMaxTurns(row.companyId, row.campaignId);
      bundle.settings.maxTurns = Math.min(bundle.settings.maxTurns, maxTurns);
    }
    if (row.status !== "active") await turns.activate(row.companyId, sessionId, row.startedAt ?? new Date());

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
        else if (ev.type === "control") {
          // Echoed before the interviewer's turn so the client can show what it asked for and
          // move the progress chips at once. Never a message (D-170).
          yield {
            event: "control",
            data: {
              kind: ev.control.kind,
              ...(ev.control.areaKey ? { areaKey: ev.control.areaKey } : {}),
              at: ev.at,
              progress: { areas: progress(ev.state) },
            },
          };
        } else if (ev.type === "turn") {
          ended = ev.turn.endInterview;
          // The engine flagged this interview on this turn: tell the tenant's admins once, with
          // ids only (the reason is model prose about a person and stays on the session). The key
          // is per session, so a later flag on the same interview is not a second notice.
          if (ev.state.flaggedForAdmin && !snapshot.state.flaggedForAdmin) {
            void ctx.alerts.raise({
              kind: "session.flagged",
              key: `session.flagged:${sessionId}`,
              companyId: row.companyId,
              title: "An interview needs a person to look at it",
              message:
                "The interviewer flagged an interview for hostility or distress. Open the campaign's interviews and filter on flagged to review it.",
              context: { sessionId, ...(row.campaignId ? { campaignId: row.campaignId } : {}) },
            });
          }
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
        await turns.complete(row.companyId, sessionId);
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
      const e = err as { code?: string; message?: string; name?: string; notified?: boolean };
      const code =
        e.name === "BudgetExceededError"
          ? "budget_exceeded"
          : e.name === "ProviderError"
            ? "provider_error"
            : "internal";
      ctx.log.error({ err, sessionId }, "turn failed");
      if (code === "budget_exceeded") await turns.pause(row.companyId, sessionId);
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
    }
  } finally {
    // Runs when the consumer stops early too: a voice client that disconnects mid-turn must not
    // leave the session locked for the whole TTL. The in-flight beat settles first, so it cannot
    // renew the lock after it has been released.
    clearInterval(heartbeat);
    await beating;
    abort.abort();
    await turns.releaseLock(row.companyId, sessionId, lock.token);
  }
}

/**
 * Renders one turn as server-sent events (contract 16). The text interview's transport.
 */
export async function runTurn(
  ctx: RouteContext,
  sessionId: string,
  answer: TurnAnswer | undefined,
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
  const told = { concluded: false };
  const sendTracked = (item: TurnEvent): void => {
    send(item);
    if (item.event === "turn" || item.event === "ended" || item.event === "error") told.concluded = true;
  };
  try {
    if (!first.done) {
      sendTracked(first.value);
      for await (const item of stream) sendTracked(item);
    }
    if (!told.concluded && ctx.shutdown.signal.aborted && !gone.signal.aborted) {
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
