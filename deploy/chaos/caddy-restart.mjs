#!/usr/bin/env node
// Caddy is restarted while a participant is mid-turn. Expected: the connection drops (it is the
// proxy), the participant's session is untouched, the proxy is back within seconds on the SAME
// certificate (the CA and keys live in the caddy_data volume; a new one on every restart would trip
// every pinned client and burn ACME rate limits in production), and the maintenance flag volume
// survives.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { connect } from "node:tls";
import {
  BASE,
  check,
  dc,
  fakeControl,
  log,
  newParticipant,
  REPO,
  scenario,
  sleep,
  stackHealthy,
  transcript,
  turn,
  waitFor,
} from "./lib.mjs";

function fingerprint() {
  const url = new URL(BASE);
  return new Promise((resolve, reject) => {
    const s = connect(
      {
        host: url.hostname,
        port: Number(url.port || 443),
        servername: url.hostname,
        rejectUnauthorized: false,
      },
      () => {
        const cert = s.getPeerCertificate();
        s.end();
        resolve(cert.fingerprint256);
      },
    );
    s.on("error", reject);
    s.setTimeout(3000, () => {
      s.destroy();
      reject(new Error("tls timeout"));
    });
  });
}

await scenario("caddy-restart", async () => {
  const before = await fingerprint();
  const p = await newParticipant("chaos-caddy");
  const opened = await turn(p);
  check("the interview opens", opened.message && !opened.error, opened.error?.code);

  await fakeControl({ charsPerSecond: 40, latencyMs: 300, jitterMs: 0 });
  let restartedAt = 0;
  // Asynchronously: a synchronous spawn would stop this process from reading its own stream.
  setTimeout(() => {
    restartedAt = Date.now();
    execFile(join(REPO, "deploy", "dc"), ["restart", "--timeout", "1", "caddy"], () =>
      log("caddy restarted"),
    );
  }, 1500);
  let cut = false;
  try {
    const out = await turn(p, "The porters get a phone call from the clerk for every move.");
    cut = !out.message || Boolean(out.error);
  } catch {
    cut = true;
  }
  check("the in-flight stream is cut by the restart", cut, "");
  await fakeControl({ charsPerSecond: 400, latencyMs: 300, jitterMs: 100 });

  const back = await waitFor(
    "the proxy to answer again",
    async () => {
      try {
        const r = await fetch(`${BASE}/auth/signin`, { signal: AbortSignal.timeout(2000) });
        return r.status;
      } catch {
        return null;
      }
    },
    { timeoutMs: 60_000, everyMs: 300 },
  );
  const outage = (Date.now() - restartedAt) / 1000;
  check("the proxy answers again", back === 200, `${back} after ${outage.toFixed(1)} s`);
  check("within half a minute", outage < 30, `${outage.toFixed(1)} s`);

  const after = await fingerprint();
  check(
    "with the same certificate (the local CA persisted in the caddy_data volume)",
    before === after,
    `${before.slice(0, 23)}... ${before === after ? "unchanged" : "CHANGED"}`,
  );

  await stackHealthy(90_000);
  check("caddy is healthy again by itself (healthcheck passes)", /healthy/.test(dc("ps", "caddy")), "");
  const view = await transcript(p);
  check(
    "the participant's session is untouched and active",
    (view.status ?? view.session?.status) === "active",
    "",
  );
  let next = await turn(p, "Back again after the page dropped.");
  for (let i = 0; i < 5 && next.error; i++) {
    await sleep(3000);
    next = await turn(p, "Back again after the page dropped.");
  }
  check("and they can carry on", !next.error && next.message, next.error?.code);
});
