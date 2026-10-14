#!/usr/bin/env node
// The API process is killed with SIGKILL while it is streaming an interview turn. Expected: the
// browser's stream ends (the client sees a broken stream and keeps the answer to send again), the
// participant's answer is already saved, the session can be resumed after the API comes back, and the
// turn lock does not trap them for more than its TTL (10 s, D-282). Nothing is doubled: one copy of the
// answer, and at most one interviewer reply per answer.
import {
  check,
  crash,
  fakeControl,
  log,
  newParticipant,
  note,
  restartCount,
  scenario,
  sleep,
  stackHealthy,
  transcript,
  turn,
  waitFor,
} from "./lib.mjs";

await scenario("kill-api", async () => {
  const p = await newParticipant("chaos-kill-api");
  const opened = await turn(p);
  check("the interview opens", opened.message && !opened.error, opened.error?.code);
  const ok = await turn(p, "I am a ward clerk and I keep bed status.");
  check("an ordinary turn is taken", ok.message && !ok.error, ok.error?.code);
  const before = JSON.stringify(await transcript(p));
  const messagesBefore = (before.match(/"role"/g) ?? []).length;

  // A slow stream, so the kill lands inside the turn.
  await fakeControl({ charsPerSecond: 25, latencyMs: 300, jitterMs: 0 });
  const restarts = restartCount("api");
  const answer = "We type the whole board again at the end of every shift.";
  let killedAt = 0;
  setTimeout(() => {
    killedAt = Date.now();
    crash("api");
    log("api killed with SIGKILL mid-stream");
  }, 2500);
  const started = Date.now();
  let broke = null;
  try {
    const out = await turn(p, answer);
    broke = out.message
      ? null
      : (out.error ?? { code: "no-message", message: "stream ended without a turn" });
    if (out.message) check("the stream was cut before the turn completed", false, "the turn completed");
  } catch (e) {
    broke = { code: "transport", message: String(e.cause?.code ?? e.message) };
  }
  check(
    "the client sees the stream end without a completed turn",
    broke !== null,
    `${broke?.code}: ${broke?.message} after ${Date.now() - started} ms`,
  );

  await fakeControl({ charsPerSecond: 400, latencyMs: 300, jitterMs: 100 });
  await waitFor("the restart policy to bring the API back", () => restartCount("api") > restarts, {
    timeoutMs: 90_000,
    everyMs: 500,
  });
  await stackHealthy(180_000);
  check(
    "the API is back and healthy by itself",
    true,
    `${Math.round((Date.now() - killedAt) / 1000)} s after the kill`,
  );

  const view = await transcript(p);
  check("the session is intact and active", (view.status ?? view.session?.status) === "active", "");
  const text = JSON.stringify(view);
  const saved = text.includes("type the whole board again");
  check("the participant's answer was saved before the stream was cut", saved, "");
  const copies = (text.match(/type the whole board again/g) ?? []).length;
  check("exactly one copy of it", copies === 1 || (!saved && copies === 0), `${copies}`);

  // Resume: how long until a turn is accepted again. The lock is held by a process that no longer
  // exists; it expires after 10 s at the latest (TURN_LOCK_TTL_MS).
  const resumeStart = Date.now();
  let resumed = null;
  let attempts = 0;
  while (!resumed && Date.now() - resumeStart < 150_000) {
    attempts++;
    const out = await turn(p, saved ? "Sorry, the page went away. Where were we?" : answer);
    if (!out.error && out.message) resumed = out;
    else {
      note(
        `attempt ${attempts} after ${Math.round((Date.now() - resumeStart) / 1000)} s: ${out.error?.code}`,
      );
      await sleep(3500);
    }
  }
  const waited = Math.round((Date.now() - resumeStart) / 1000);
  check(
    "the session is resumable: a turn is accepted again",
    resumed !== null,
    `after ${waited} s and ${attempts} attempt(s)`,
  );
  check(
    "within the API's restart plus the turn lock's TTL (10 s) of the crash",
    waited + Math.round((resumeStart - killedAt) / 1000) <= 40,
    `${waited + Math.round((resumeStart - killedAt) / 1000)} s from the kill`,
  );
  const after = JSON.stringify(await transcript(p));
  const messagesAfter = (after.match(/"role"/g) ?? []).length;
  check(
    "the transcript only grew (nothing lost, no duplicate of the interrupted answer)",
    messagesAfter > messagesBefore && (after.match(/type the whole board again/g) ?? []).length <= 1,
    `${messagesBefore} -> ${messagesAfter} messages`,
  );
});
