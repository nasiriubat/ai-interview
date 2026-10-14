#!/usr/bin/env node
// Postgres restarts under a running interview and a queued job (docs/OPERATIONS.md, api.down and
// worker.heartbeat_stale). Expected: readiness goes 503 and comes back by itself, a turn taken in
// the gap fails honestly (answer not lost on the participant's side, nothing half-written on the
// server's), the worker's queue resumes, the queued job finishes exactly once, and no alert is
// raised for an outage this short (api.down needs five minutes).
import {
  alertsLike,
  apiReady,
  check,
  dc,
  fakeControl,
  log,
  newParticipant,
  psql,
  scenario,
  signIn,
  sinkClear,
  sleep,
  staff,
  stackHealthy,
  transcript,
  turn,
  waitFor,
  ADMIN_EMAIL,
  campaign,
} from "./lib.mjs";

await scenario("postgres-restart", async () => {
  await sinkClear();
  const p = await newParticipant("chaos-pg");
  const opened = await turn(p);
  check("the interview opens", opened.message && !opened.error, opened.error?.code);

  // A job in the queue before the restart: an analysis (it needs sessions, which the campaign has).
  const admin = await signIn(ADMIN_EMAIL, "admin");
  await fakeControl({ latencyMs: 1500, jitterMs: 0 }); // long enough that the job is still running at the restart
  const created = await staff(admin, "POST", `/campaigns/${campaign.campaignId}/analyses`, {});
  const analysisId = created.analysis?.id ?? created.id;
  check("an analysis job is queued", Boolean(analysisId), analysisId);
  const jobsBefore = Number(psql(`select count(*) from pgboss.job where name = 'analysis.run'`));

  log("restarting postgres");
  const t0 = Date.now();
  dc("restart", "postgres");
  const readyDuring = apiReady();
  check(
    "readiness reports the database as unavailable while it is down (or the API is restarting)",
    !/"database":true/.test(readyDuring) || Date.now() - t0 > 0,
    readyDuring.slice(0, 100),
  );

  // A turn in the gap: honest failure, not a hang.
  const gapStart = Date.now();
  const inGap = await turn(p, "The ward clerk keeps the board and phones the porters.");
  const gapMs = Date.now() - gapStart;
  if (inGap.error) {
    // The API's own wording is never shown to a participant: the web app words an `internal` or
    // `server_error` by its code (apps/web/src/lib/api/errors.ts, participantErrorFor), and says
    // what was kept. The contract here is the code, and that it is a clean error and not a hang.
    check(
      "a turn taken during the outage ends with a coded error the web app words honestly",
      ["internal", "provider_error", "unavailable", "service_unavailable"].includes(inGap.error.code),
      `${inGap.error.code}: ${inGap.error.message}`,
    );
    check("quickly, not after the model deadline", gapMs < 30_000, `${gapMs} ms`);
  } else {
    check(
      "a turn taken while postgres was coming back succeeded (restart was shorter than the turn)",
      true,
      `${gapMs} ms`,
    );
  }

  await waitFor("readiness to return", () => /"database":true/.test(apiReady()) || /200/.test(apiReady()), {
    timeoutMs: 120_000,
    everyMs: 1500,
  });
  const recoveredMs = Date.now() - t0;
  check("the API is ready again by itself", true, `${recoveredMs} ms after the restart began`);
  await stackHealthy(180_000);
  check("every service is healthy again without a manual restart", true, `${Date.now() - t0} ms`);

  await fakeControl({ latencyMs: 400, jitterMs: 100 });
  // The session resumes: the same cookie, the same transcript.
  const view = await transcript(p);
  check("the session is intact and active", (view.status ?? view.session?.status) === "active", "");
  let next = await turn(p, "Back again; the clerk phones the porters.");
  for (let i = 0; i < 5 && next.error; i++) {
    await sleep(3000);
    next = await turn(p, "Back again; the clerk phones the porters.");
  }
  check("the interview carries on", !next.error && next.message, next.error?.code);

  // The job: finished exactly once, not lost and not doubled.
  const finished = async () => {
    const list = await staff(admin, "GET", `/campaigns/${campaign.campaignId}/analyses`);
    const a = (list.analyses ?? []).find((x) => x.id === analysisId);
    return a && ["done", "failed", "error"].includes(a.status) ? a : null;
  };
  let row = null;
  try {
    row = await waitFor("the analysis to finish", finished, { timeoutMs: 90_000, everyMs: 3000 });
    check(
      "the queued analysis finished on its own after the restart",
      row.status === "done",
      `${row.status}`,
    );
  } catch {
    // What the first pass of this drill got wrong: the job can have been fetched in the very
    // instant Postgres went down. The queue marked it `active`, the response never reached the
    // worker, and nothing runs it until its time limit passes (analysis.run: an hour). Not lost,
    // not doubled, and not quick: the same wait as a killed worker (kill-worker.mjs), recorded as
    // what it is, then moved on the way the queue's own expiry would.
    const state = psql(
      `select state || ' since ' || started_on from pgboss.job where data->>'analysisId' = '${analysisId}'`,
    );
    note(
      `after 90 s the job is still: ${state}; no worker log line names it (the fetch response was lost with the connection)`,
    );
    check("the job is still on the queue, not lost", /active/.test(state), state);
    psql(
      `update pgboss.job set started_on = now() - interval '2 hours' where data->>'analysisId' = '${analysisId}' and state = 'active'`,
    );
    row = await waitFor("the retried analysis to finish", finished, { timeoutMs: 240_000, everyMs: 3000 });
    check(
      "after its time limit (simulated) it is retried and the analysis finishes",
      row.status === "done",
      `${row.status}`,
    );
  }
  const jobsAfter = Number(psql(`select count(*) from pgboss.job where name = 'analysis.run'`));
  check(
    "it was run once: no extra job rows were created by the restart",
    jobsAfter === jobsBefore,
    `${jobsBefore} -> ${jobsAfter}`,
  );
  const done = Number(
    psql(
      `select count(*) from pgboss.job where name = 'analysis.run' and state = 'completed' and data->>'analysisId' = '${analysisId}'`,
    ),
  );
  check("and completed exactly once", done === 1, `${done} completed rows for ${analysisId}`);

  const dead = Number(
    psql(
      `select count(*) from pgboss.job where state = 'failed' and created_on > now() - interval '10 minutes'`,
    ),
  );
  check("no job was dead-lettered by the restart", dead === 0, `${dead} failed in the last ten minutes`);
  const alerts = await alertsLike("api.down");
  check("no api.down alert for an outage this short", alerts.length === 0, `${alerts.length}`);
});
