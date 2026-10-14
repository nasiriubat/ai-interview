#!/usr/bin/env node
// The model provider starts answering 503 to everything (docs/OPERATIONS.md, "Provider outages",
// alert provider.error_rate). Expected: the participant's turn ends with an error that says their
// answer is saved, the session stays active and resumable, the circuit opens so later calls fail
// at once instead of each waiting out a timeout, the operator is alerted through the webhook, and
// when the provider returns the interview carries on.
import {
  alertsLike,
  check,
  fakeControl,
  fakeReset,
  log,
  newParticipant,
  runHealthSweep,
  scenario,
  sinkClear,
  sleep,
  transcript,
  turn,
} from "./lib.mjs";

await scenario("provider-5xx", async () => {
  await fakeReset();
  await sinkClear();
  const p = await newParticipant("chaos-5xx");
  const first = await turn(p);
  check(
    "the interview opens while the provider is healthy",
    first.message && !first.error,
    first.error?.code,
  );
  const ok = await turn(p, "I keep bed status for the ward, mostly on paper.");
  check("a normal answer is taken", ok.message && !ok.error, ok.error?.code);

  await fakeControl({ errorRate: 1, errorStatus: 503 });
  log("provider now answers 503 to every call");
  const answer = "We retype everything at the end of the shift.";
  const started = Date.now();
  const bad = await turn(p, answer);
  const took = Date.now() - started;
  check("the turn ends with an error, not a hang", bad.error !== null, `${bad.error?.code} after ${took} ms`);
  check("and it says the answer is saved", /saved/i.test(bad.error?.message ?? ""), bad.error?.message);
  check("within a few seconds (two retries, not minutes)", took < 30_000, `${took} ms`);

  const view = await transcript(p);
  check(
    "the session stays active",
    (view.status ?? view.session?.status) === "active",
    view.status ?? view.session?.status,
  );
  const said = JSON.stringify(view);
  check("and the answer is in the transcript", said.includes("retype everything"), "");

  // Five failures inside a minute open the circuit; from then on calls fail without a round trip.
  const times = [];
  for (let i = 0; i < 6; i++) {
    const t = Date.now();
    const out = await turn(p, `Still here, try ${i}.`);
    times.push(Date.now() - t);
    if (!out.error) check(`attempt ${i} unexpectedly succeeded`, false, "");
    await sleep(3200); // the route allows 20 turns a minute
  }
  const fastest = Math.min(...times);
  check(
    "once the circuit is open a turn fails fast",
    times.at(-1) < 3000 && fastest < 3000,
    `${times.join(", ")} ms`,
  );

  await runHealthSweep();
  await sleep(2000);
  const alerts = await alertsLike("provider");
  check(
    "the operator is told through the webhook (provider.error_rate or fallback)",
    alerts.length > 0,
    `${alerts.length} message(s): ${alerts[0]?.title ?? alerts[0]?.body?.slice(0, 120) ?? ""}`,
  );

  await fakeReset();
  log("provider recovered; waiting out the circuit's half-open probe");
  let recovered = null;
  for (let i = 0; i < 12 && !recovered; i++) {
    await sleep(5000);
    const out = await turn(p, "I am back; where were we?");
    if (!out.error && out.message) recovered = out;
  }
  check("the interview carries on after the provider is back", recovered !== null, "");
  const after = await transcript(p);
  check("still the same session, still active", (after.status ?? after.session?.status) === "active", "");
});
