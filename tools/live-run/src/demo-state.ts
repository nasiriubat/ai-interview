import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the marketing demo keeps what one step hands the next (campaign ids, analysis ids): a
 * directory outside the repository named by DEMO_DIR. Nothing secret is written there; the auth
 * secret lives in DEMO_STATE, which the stack writes.
 */
export function demoDir(): string {
  const dir = process.env.DEMO_DIR;
  if (!dir) throw new Error("DEMO_DIR must name a directory outside the repository");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readDemo(name: string): unknown {
  return JSON.parse(readFileSync(join(demoDir(), name), "utf8"));
}

export function writeDemo(name: string, value: unknown): void {
  writeFileSync(join(demoDir(), name), JSON.stringify(value, null, 2));
}

export function readStackState(): { authSecret: string } {
  const path = process.env.DEMO_STATE;
  if (!path) throw new Error("DEMO_STATE must name the state file demo-stack wrote");
  return JSON.parse(readFileSync(path, "utf8")) as { authSecret: string };
}

/**
 * The three discovery campaigns of the demo: one fictional clinic network, three questions, each
 * asked of the people it concerns. Case `ops` asks all nine, three per department, so the
 * department comparison clears the anonymity threshold.
 */
export const DEMO_CASES = {
  ops: {
    name: "Where does our week go? Clinic operations 2026",
    welcome:
      "Hello from the clinic leadership team. Before we decide what to change, we want to understand how your week really goes: what takes your time, what gets in the way and what already works. There are no right or wrong answers, and you can pause and come back whenever you like.",
    personas: ["rec_1", "rec_2", "rec_3", "bil_1", "bil_2", "bil_3", "nur_1", "nur_2", "nur_3"],
  },
  billing: {
    name: "Month end without the overtime: billing and front desk",
    welcome:
      "Month end keeps running late. Tell us, in your own words, where the hours go between a visit and a paid invoice, and what you would change first. Your answers are combined with other people's before anyone sees them.",
    personas: ["bil_1", "bil_2", "bil_3", "rec_1", "rec_2", "rec_3"],
  },
  handover: {
    name: "Shift handover and supplies: nursing teams",
    welcome:
      "We want to make handovers and supply orders easier, and we want to start from how they work today. Walk us through a normal shift. It takes as long as you need, and you can stop at any point.",
    personas: ["nur_1", "nur_2", "nur_3", "rec_1", "rec_2", "rec_3"],
  },
} as const;
export type DemoCase = keyof typeof DEMO_CASES;

export function demoCase(env: NodeJS.ProcessEnv = process.env): DemoCase {
  const c = env.DEMO_CASE ?? "ops";
  if (!(c in DEMO_CASES)) throw new Error(`DEMO_CASE must be one of ${Object.keys(DEMO_CASES).join(", ")}`);
  return c as DemoCase;
}
