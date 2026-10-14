import { SessionStateSchema } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { BudgetExceededError } from "../../src/callModel.js";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { fallbackRecap, generateRecap, recapFacts, recapIsCurrent } from "../../src/engine/recap.js";
import { ScriptedCaller, settings, snapshot, template } from "./helpers.js";

const covered = {
  coverage: {
    role: { status: "covered", known: "ward nurse, night shifts" },
    daily: { status: "partial", known: "" },
  },
  lastAreaKey: "daily",
} as const;

const deps = (caller: ScriptedCaller) => ({ caller: caller.asCaller(), prompts: new ShippedPromptSource() });

describe("recap facts", () => {
  it("names what is covered and what the engine would ask next, from state alone", () => {
    const facts = recapFacts(snapshot(template(), covered), settings.maxTurns);
    expect(facts).toEqual({ covered: ["Role"], next: "Daily", closing: false });
  });

  it("says the interview is at its end once finishing was requested", () => {
    const facts = recapFacts(snapshot(template(), { ...covered, finishRequested: true }), settings.maxTurns);
    expect(facts.closing).toBe(true);
    expect(facts.next).toBeUndefined();
  });
});

describe("generateRecap", () => {
  it("asks the resume_summary route with the recap prompt and the state, not the transcript", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({ recap: "You covered your role. Next is your day." }),
    ]);
    const out = await generateRecap(deps(caller), snapshot(template(), covered, "SECRET-TRANSCRIPT"), {
      maxTurns: 60,
    });

    expect(out).toEqual({ text: "You covered your role. Next is your day.", source: "model" });
    const call = caller.requests[0]!;
    expect(call.purpose).toBe("resume_summary");
    expect(call.req.system).toContain("English");
    const sent = JSON.stringify(call.req.messages);
    expect(sent).toContain("Role: covered");
    expect(sent).toContain("Next: Daily");
    expect(sent).not.toContain("SECRET-TRANSCRIPT");
  });

  it("falls back, deterministically, when the model fails", async () => {
    const caller = new ScriptedCaller([]);
    caller.complete = async () => {
      throw new Error("provider down");
    };
    const out = await generateRecap(deps(caller), snapshot(template(), covered), { maxTurns: 60 });

    expect(out.source).toBe("fallback");
    expect(out.text).toBe("Welcome back. We have already covered Role. Next we will talk about Daily.");
  });

  it("falls back when the budget is used up", async () => {
    const caller = new ScriptedCaller([]);
    caller.complete = async () => {
      throw new BudgetExceededError({ allowed: false, warnings: [] });
    };
    const out = await generateRecap(deps(caller), snapshot(template(), covered), { maxTurns: 60 });

    expect(out.source).toBe("fallback");
  });

  it("falls back on output the schema refuses (an essay is not two sentences)", async () => {
    const caller = new ScriptedCaller([JSON.stringify({ recap: "x".repeat(401) })]);
    const out = await generateRecap(deps(caller), snapshot(template(), covered), { maxTurns: 60 });

    expect(out.source).toBe("fallback");
  });

  it("makes no model call when nothing is covered yet", async () => {
    const caller = new ScriptedCaller([JSON.stringify({ recap: "unused" })]);
    const out = await generateRecap(deps(caller), snapshot(template()), { maxTurns: 60 });

    expect(caller.requests).toHaveLength(0);
    expect(out.source).toBe("fallback");
    expect(out.text).toContain("just getting started");
  });
});

describe("fallbackRecap", () => {
  it("is Finnish for a Finnish interview and joins several areas", () => {
    expect(fallbackRecap({ covered: ["Rooli", "Arki"], next: "Ongelmat", closing: false }, "fi")).toBe(
      "Tervetuloa takaisin. Olemme käsitelleet jo Rooli ja Arki. Seuraavaksi puhutaan aiheesta Ongelmat.",
    );
  });
});

describe("recap cache", () => {
  it("is current only for the message it was written at", () => {
    const state = SessionStateSchema.parse({ recap: { text: "t", upToSeq: 8, source: "model" } });
    expect(recapIsCurrent(state, 8)).toBe(true);
    expect(recapIsCurrent(state, 10)).toBe(false);
    expect(recapIsCurrent(SessionStateSchema.parse({}), 0)).toBe(false);
  });
});
