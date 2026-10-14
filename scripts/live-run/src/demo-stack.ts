/**
 * Marketing demo (marketing/demo-2026-10): starts the same stack as `live:run`, but keeps it
 * running so the web app can be pointed at it and photographed. Writes the throwaway auth secret
 * (never the provider key) to $DEMO_STATE so the other demo scripts and the web server can use it.
 */
import { writeFileSync } from "node:fs";
import { loadOpenRouterKey, log } from "./runtime.js";
import { startStack } from "./stack.js";

const statePath = process.env.DEMO_STATE;
if (!statePath) throw new Error("DEMO_STATE must name a state file outside the repository");

const stack = await startStack(loadOpenRouterKey());
writeFileSync(statePath, JSON.stringify({ authSecret: stack.authSecret, logs: stack.logs }, null, 2));
log(`demo stack ready; state in ${statePath}`);
const stop = (): void => {
  void stack.stop().then(() => process.exit(0));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => undefined, 60_000);
