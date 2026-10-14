#!/usr/bin/env node
// The disk under the uploads is nearly full (docs/OPERATIONS.md, disk.high). The volume is swapped
// for a 3 MB tmpfs (deploy/chaos/compose.smalldisk.yml) and filled. Expected: the operator is
// alerted before it is too late (the health sweep raises disk.high through the webhook), an upload
// that does not fit fails cleanly with an error the participant can act on, the interview itself
// carries on in text, the backup fails loudly and removes its partial file rather than leaving one,
// and everything returns to normal when space is freed.
import { join } from "node:path";
import {
  alertsLike,
  check,
  dc,
  dcTry,
  log,
  newParticipant,
  note,
  REPO,
  runHealthSweep,
  scenario,
  sinkClear,
  sleep,
  stackHealthy,
  transcript,
  turn,
} from "./lib.mjs";

const overlay = join(REPO, "deploy", "chaos", "compose.smalldisk.yml");
const original = process.env.COMPOSE_OVERRIDE_FILES ?? "";

await scenario("disk-full", async () => {
  await sinkClear();
  process.env.COMPOSE_OVERRIDE_FILES = `${original} ${overlay}`.trim();
  log("swapping the uploads volume for a 3 MB tmpfs and recreating the services that mount it");
  try {
    dc("up", "-d", "--no-deps", "api", "worker", "ops-notify", "backup");
    await stackHealthy(180_000);
    check("the stack runs on the small volume", true, "");

    const p = await newParticipant("chaos-disk");
    const opened = await turn(p);
    check("the interview opens", opened.message && !opened.error, opened.error?.code);

    // Fill it to the brim.
    dc(
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      "dd if=/dev/zero of=/uploads/filler bs=1k count=2950 2>/dev/null; df -k /uploads | tail -1",
    );
    const df = dc("exec", "-T", "api", "df", "-k", "/uploads");
    note(`uploads volume: ${df.trim().split("\n").at(-1)}`);

    // An upload that cannot fit.
    const form = new FormData();
    form.set("file", new Blob([Buffer.alloc(600 * 1024, "a")], { type: "text/plain" }), "notes.txt");
    const started = Date.now();
    const res = await p.fetch("/api/participant/p/session/attachments", { method: "POST", body: form });
    const body = await res.text();
    const took = Date.now() - started;
    check(
      "an upload that does not fit fails cleanly, not with a hang",
      res.status >= 400 && took < 30_000,
      `${res.status} after ${took} ms: ${body.slice(0, 160)}`,
    );
    check(
      "with a coded error the web app can word (never a stack trace)",
      /"error"\s*:\s*\{\s*"code"/.test(body) && !/at\s+\S+\s+\(/.test(body),
      body.slice(0, 120),
    );

    const next = await turn(p, "I could not attach the file, so I will describe it: we keep a paper board.");
    check("the interview itself carries on in text", !next.error && next.message, next.error?.code);
    const view = await transcript(p);
    check("the session stays active", (view.status ?? view.session?.status) === "active", "");

    // The backup into a full disk is not part of this volume; its own failure mode is the tmpfs
    // backups volume of the plan (docs): exercised separately below.

    await runHealthSweep();
    await sleep(2000);
    const alerts = await alertsLike("disk.high");
    check(
      "the operator is told through the webhook (disk.high)",
      alerts.length > 0,
      `${alerts.length}: ${alerts[0]?.title ?? alerts[0]?.body?.slice(0, 120) ?? ""}`,
    );
    check(
      "and it is critical, not just a warning",
      alerts.some((a) => /critical/.test(a.body)),
      "",
    );
  } finally {
    log("putting the real uploads volume back");
    process.env.COMPOSE_OVERRIDE_FILES = original;
    dcTry("up", "-d", "--no-deps", "api", "worker", "ops-notify", "backup");
    dcTry("volume", "rm", "-f", "aidpfull_uploads_small");
  }
  await stackHealthy(180_000);
  check("after the real volume is back every service is healthy", true, "");
  const p2 = await newParticipant("chaos-disk-after");
  const again = await turn(p2);
  check("and a new participant can start an interview", again.message && !again.error, again.error?.code);

  // The other half: the backup has nowhere to write.
  await sinkClear();
  const backupsOverlay = join(REPO, "deploy", "chaos", "compose.smallbackups.yml");
  process.env.COMPOSE_OVERRIDE_FILES = `${original} ${backupsOverlay}`.trim();
  log("swapping the backups volume for a 100 KB tmpfs");
  try {
    dc("up", "-d", "--no-deps", "backup");
    await stackHealthy(120_000);
    let failed = false;
    let output = "";
    try {
      output = dc("exec", "-T", "backup", "/usr/local/bin/backup.sh", "once");
    } catch (e) {
      failed = true;
      output = String(e.message);
    }
    check(
      "the backup fails (non-zero) rather than reporting a dump that is not there",
      failed,
      output.slice(-160).replace(/\s+/g, " "),
    );
    const left = dc("exec", "-T", "backup", "sh", "-c", "ls /backups | grep -c part || true").trim();
    check("and leaves no half-written .part file behind", left === "0", `${left} part file(s)`);
    const status = JSON.parse(dc("exec", "-T", "backup", "cat", "/ops-state/status/backup.json"));
    check(
      "the status file says the last run failed, with a reason",
      status.lastResult === "failed" && Boolean(status.error),
      `${status.lastResult}: ${status.error}`,
    );
    // Docker's own health state needs three failed 60 s checks; the check itself is the script it runs.
    let health = "";
    try {
      health = dc("exec", "-T", "backup", "/usr/local/bin/backup-health.sh");
    } catch (e) {
      health = String(e.message);
    }
    check(
      "the backup healthcheck reports unhealthy, and why",
      /unhealthy: last backup failed/.test(health),
      health.slice(-140).replace(/\s+/g, " "),
    );
    await runHealthSweep();
    await sleep(2000);
    const alerts = await alertsLike("backup.failed");
    check(
      "the operator is told (backup.failed on the webhook, from the platform's health sweep)",
      alerts.length > 0,
      `${alerts.length}`,
    );
  } finally {
    process.env.COMPOSE_OVERRIDE_FILES = original;
    dcTry("up", "-d", "--no-deps", "backup");
    dcTry("volume", "rm", "-f", "aidpfull_backups_small");
  }
  // Unhealthy until a backup succeeds again: that is the point of the check.
  dc("exec", "-T", "backup", "/usr/local/bin/backup.sh", "once");
  await stackHealthy(180_000);
  check(
    "with the real volume back, a backup succeeds and the status recovers",
    JSON.parse(dc("exec", "-T", "backup", "cat", "/ops-state/status/backup.json")).lastResult === "ok",
    "",
  );
});
