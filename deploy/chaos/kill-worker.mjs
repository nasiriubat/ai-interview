#!/usr/bin/env node
// The worker is killed with SIGKILL (no graceful drain) in the middle of an analysis job
// (docs/OPERATIONS.md, "Background jobs", job.stuck). Expected: Docker restarts the worker, the
// job is not lost, and once the queue's own expiry has passed it is retried and finishes exactly
// once, with one result.
//
// pg-boss fails an active job only after its `expireInSeconds` (analysis.run: 3600), so waiting
// for that is an hour. The script says what it observes in the meantime, then moves the job's
// start time back by two hours, which is what the passage of the expiry is to the queue, and
// watches the retry. That step is a simulation of time, and is labelled as one.
import {
  ADMIN_EMAIL,
  alertsLike,
  campaign,
  check,
  crash,
  restartCount,
  fakeControl,
  log,
  note,
  psql,
  scenario,
  signIn,
  sleep,
  staff,
  stackHealthy,
  waitFor,
} from "./lib.mjs";

await scenario("kill-worker", async () => {
  const admin = await signIn(ADMIN_EMAIL, "admin");
  await fakeControl({ latencyMs: 2500, jitterMs: 0 });
  const created = await staff(admin, "POST", `/campaigns/${campaign.campaignId}/analyses`, {});
  const analysisId = created.analysis?.id ?? created.id;
  check("an analysis is queued", Boolean(analysisId), analysisId);

  const jobId = await waitFor(
    "the analysis job to be active",
    () =>
      psql(
        `select id from pgboss.job where name = 'analysis.run' and state = 'active' and data->>'analysisId' = '${analysisId}'`,
      ) || null,
    { timeoutMs: 60_000, everyMs: 500 },
  );
  check("the worker has picked it up", Boolean(jobId), jobId);
  await sleep(3000);

  const restartsBefore = restartCount("worker");
  const startedAt = Date.now();
  crash("worker");
  log("worker killed with SIGKILL mid-job");
  const during = psql(`select state from pgboss.job where id = '${jobId}'`);
  check("the job is still on the queue, active, not lost", during === "active", during);

  await waitFor("docker to restart the worker", () => restartCount("worker") > restartsBefore, {
    timeoutMs: 60_000,
    everyMs: 500,
  });
  await stackHealthy(180_000);
  check(
    "the restart policy brings the worker back, healthy, by itself",
    true,
    `${Math.round((Date.now() - startedAt) / 1000)} s`,
  );

  // What the platform does on its own in the next minute.
  await sleep(20_000);
  const state = psql(
    `select state || ' / retry ' || retry_count || ' of ' || retry_limit from pgboss.job where id = '${jobId}'`,
  );
  const analysisState = psql(`select status from "Analysis" where id = '${analysisId}'`);
  note(
    `twenty seconds after the restart the job is: ${state}; the analysis row is: ${analysisState} (pg-boss fails an active job at expireInSeconds, 3600 for analysis.run)`,
  );
  check(
    "nothing has run it twice in the meantime",
    Number(
      psql(
        `select count(*) from pgboss.job where name = 'analysis.run' and data->>'analysisId' = '${analysisId}'`,
      ),
    ) === 1,
    "",
  );

  // Simulated: the expiry has passed.
  log("simulating the expiry: moving the job's start time back two hours");
  psql(`update pgboss.job set started_on = now() - interval '2 hours' where id = '${jobId}'`);
  await fakeControl({ latencyMs: 100, jitterMs: 0 });
  const finished = await waitFor(
    "the retried analysis to finish",
    () => {
      const s = psql(`select status from "Analysis" where id = '${analysisId}'`);
      return ["done", "failed", "error"].includes(s) ? s : null;
    },
    { timeoutMs: 300_000, everyMs: 3000 },
  );
  check("after the expiry the job is retried and the analysis completes", finished === "done", finished);
  const rows = Number(psql(`select count(*) from "Analysis" where id = '${analysisId}'`));
  check("one analysis row, not two", rows === 1, `${rows}`);
  const completed = Number(
    psql(
      `select count(*) from pgboss.job where name = 'analysis.run' and data->>'analysisId' = '${analysisId}' and state = 'completed'`,
    ),
  );
  check("the job completed exactly once", completed === 1, `${completed}`);
  const opportunities = Number(
    psql(`select count(*) from "Opportunity" where "analysisId" = '${analysisId}'`),
  );
  const clusters = Number(psql(`select stats->>'clusters' from "Analysis" where id = '${analysisId}'`));
  check(
    "and wrote its results once: one opportunity per cluster, none doubled by the retry",
    opportunities === clusters,
    `${opportunities} opportunities for ${clusters} clusters`,
  );
  const stuck = await alertsLike("job.stuck");
  note(`job.stuck alerts seen on the webhook: ${stuck.length}`);
});
