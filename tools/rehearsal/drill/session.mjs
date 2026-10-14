#!/usr/bin/env node
// Prints a signed-in staff member's session cookie as `name=value`, for tools/load/run.sh to hand to k6
// (which cannot follow a magic link). Signs in through the real flow, like everything else here.
//
//   tools/rehearsal/drill/stack.sh run node tools/rehearsal/drill/session.mjs admin
//   tools/rehearsal/drill/stack.sh run node tools/rehearsal/drill/session.mjs operator
import { ADMIN_EMAIL, OPERATOR_EMAIL, signIn } from "./lib.mjs";

const who = process.argv[2] ?? "admin";
const client = await signIn(who === "operator" ? OPERATOR_EMAIL : ADMIN_EMAIL, who);
const names = [...client.jar.keys()].filter((k) => k.includes("session-token"));
if (names.length === 0) throw new Error("no session cookie after sign-in");
// Chunked cookies (.0, .1) are joined in order; a normal session is one cookie.
console.log(
  names
    .sort()
    .map((k) => `${k}=${client.jar.get(k)}`)
    .join("; "),
);
