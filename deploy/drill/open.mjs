#!/usr/bin/env node
// Opens the drill campaign's link a few times and prints what came back: the quickest way to see
// why a load run's opens are failing (a limit, a closed campaign, a ceiling).
//
//   deploy/drill/stack.sh run node deploy/drill/open.mjs [count]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "./lib.mjs";

const campaign = JSON.parse(readFileSync(join(process.env.AIDP_DRILL_DIR, "campaign.json"), "utf8"));
const count = Number(process.argv[2] ?? 3);
const p = new Client("open-probe");
for (let i = 0; i < count; i++) {
  const r = await p.json("POST", `/api/participant/p/${campaign.linkToken}/open`, {});
  console.log(r.status, JSON.stringify(r.body).slice(0, 300));
}
