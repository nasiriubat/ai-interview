/**
 * Marketing demo: starts the same stack as `live:run`, but keeps it running so the web app can be
 * pointed at it and photographed. The provider is the run's (`backend.ts`: LIVE_PROVIDER=meta for
 * Meta's Model API). Writes the throwaway auth secret (never a provider key) to $DEMO_STATE so the
 * other demo scripts and the web server can use it.
 */
import { writeFileSync } from "node:fs";
import { harnessBackend } from "./backend.js";
import { log } from "./runtime.js";
import { startStack } from "./stack.js";

const statePath = process.env.DEMO_STATE;
if (!statePath) throw new Error("DEMO_STATE must name a state file outside the repository");

const backend = harnessBackend();
const stack = await startStack(backend.bootstrapEnv);
writeFileSync(
  statePath,
  JSON.stringify({ authSecret: stack.authSecret, logs: stack.logs, provider: backend.provider }, null, 2),
);
log(`demo stack ready on ${backend.provider}; state in ${statePath}`);
const stop = (): void => {
  void stack.stop().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => undefined, 60_000);
