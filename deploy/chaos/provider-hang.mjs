#!/usr/bin/env node
// The model provider accepts the request and never answers. Expected (docs/OPERATIONS.md,
// "Provider timeouts and retries"): the call is cut at the first-token deadline, the participant is
// told their answer is saved, the turn lock is released in the same moment (so they can retry within
// seconds, not after the lock's 90 s), and nothing is left hanging.
import {
  check,
  fakeControl,
  fakeReset,
  log,
  newParticipant,
  scenario,
  sleep,
  transcript,
  turn,
} from "./lib.mjs";

const FIRST_TOKEN_DEADLINE_MS = 8000; // PROVIDER_FIRST_TOKEN_TIMEOUT_MS in the drill's env file
const RETRIES = 1; // PROVIDER_MAX_RETRIES

await scenario("provider-hang", async () => {
  await fakeReset();
  const p = await newParticipant("chaos-hang");
  const opened = await turn(p);
  check("the interview opens", opened.message && !opened.error, opened.error?.code);

  await fakeControl({ hangRate: 1, hangMs: 0 });
  log("provider now accepts calls and never answers");
  const started = Date.now();
  const hung = await turn(p, "The clerk keeps the board on paper and then in a spreadsheet.");
  const took = Date.now() - started;
  const ceiling = (RETRIES + 1) * FIRST_TOKEN_DEADLINE_MS + 5000;
  check("the turn ends with an error", hung.error !== null, `${hung.error?.code}`);
  check(
    "at the first-token deadline (with its retry), not at the two-minute ceiling",
    took < ceiling,
    `${took} ms against ${ceiling} ms`,
  );
  check("and says the answer is saved", /saved/i.test(hung.error?.message ?? ""), hung.error?.message);

  // The lock is released: with the provider back, the next turn is accepted at once.
  await fakeReset();
  const retried = Date.now();
  let again = await turn(p, "Trying again now.");
  // The circuit may be open after the failures; its probe is within thirty seconds.
  for (let i = 0; i < 8 && again.error; i++) {
    await sleep(5000);
    again = await turn(p, "Trying again now.");
  }
  check(
    "the same participant can answer again without waiting for the lock",
    !again.error && again.message,
    `${again.error?.code ?? "ok"} after ${Date.now() - retried} ms`,
  );
  const view = await transcript(p);
  check("the session is active", (view.status ?? view.session?.status) === "active", "");
  check("the hung answer was kept", JSON.stringify(view).includes("keeps the board on paper"), "");
});
