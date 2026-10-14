#!/usr/bin/env node
// The worker is killed with SIGKILL (no graceful drain) in the middle of an analysis job
// (docs/OPERATIONS.md, "Background jobs", job.stuck). Expected: Docker restarts the worker, the
// job is not lost, the restarted worker notices that the process which owned the job is gone (its
// lease stopped being refreshed) and fails the job so the queue retries it within about a minute,
// not after `expireInSeconds` (analysis.run: 3600), and it finishes exactly once, with one result
// (D-281). Nothing about time is simulated.
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

  // What the platform does on its own: the lease of the killed process goes stale (45 s) and the
  // next recovery pass fails its job, which the queue then retries.
  await fakeControl({ latencyMs: 100, jitterMs: 0 });
  const reclaimedAfter = await waitFor(
    "the queue to retry the job without waiting for its expiry",
    () => {
      const s = psql(`select retry_count from pgboss.job where id = '${jobId}'`);
      return Number(s) >= 1 ? Number(s) : null;
    },
    { timeoutMs: 150_000, everyMs: 2000 },
  );
  check("the job was retried within minutes of the kill", Boolean(reclaimedAfter), `${reclaimedAfter}`);
  check(
    "nothing has run it twice in the meantime",
    Number(
      psql(
        `select count(*) from pgboss.job where name = 'analysis.run' and data->>'analysisId' = '${analysisId}'`,
      ),
    ) === 1,
    "",
  );
  const finished = await waitFor(
    "the retried analysis to finish",
    () => {
      const s = psql(`select status from "Analysis" where id = '${analysisId}'`);
      return ["done", "failed", "error"].includes(s) ? s : null;
    },
    { timeoutMs: 300_000, everyMs: 3000 },
  );
  check("the job is retried and the analysis completes", finished === "done", finished);
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
