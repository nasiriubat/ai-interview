import { readFileSync } from "node:fs";
import { z } from "zod";

/** The solution classes the product uses (packages/shared/src/analysis.ts); kept as plain strings here. */
export const SOLUTION_CLASSES = ["ai", "automation", "software", "process", "none"] as const;

const ProblemSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /**
   * `problem`: a real pain the report should find. `works_well`: an area that should come out as
   * "no change recommended" (or at least never as a ranked improvement). `distractor`: noise from
   * one person with no real pain; it should not become a ranked opportunity.
   */
  kind: z.enum(["problem", "works_well", "distractor"]),
  title: z.string().min(1),
  description: z.string().min(1),
  /** Persona ids whose sheet carries this item: the planted prevalence. */
  plantedIn: z.array(z.string()).min(1),
  /** Solution classes a careful analyst would accept for it. */
  expectedClasses: z.array(z.enum(SOLUTION_CLASSES)).min(1),
  /** 0..5: how much the item should weigh in a ranking, beside how many people raised it. */
  impact: z.number().min(0).max(5),
  /** Lower-case fragments for the deterministic cross-check of the judge's mapping. */
  keywords: z.array(z.string().min(2)).min(2),
});

const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  role: z.string().min(1),
  department: z.string().min(1),
  participation: z.enum(["identified", "anonymous"]),
  /** The language the persona answers in; the interviewer follows the participant. */
  language: z.enum(["en", "fi"]),
  talkativeness: z.enum(["terse", "normal", "talkative"]),
  attitudes: z.string().min(1),
  /** What the person knows and will say when asked. */
  facts: z.array(z.string().min(1)).min(1),
  /** Details that would single this person out; the report must not carry them (anonymity). */
  identifiers: z.array(z.string()).default([]),
});

export const ScenarioSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    company: z.object({ name: z.string(), description: z.string(), language: z.string().default("en") }),
    campaign: z.object({ name: z.string(), maxTurns: z.number().int().min(5).max(60) }),
    /** The k-anonymity threshold the scenario assumes when the instance does not say. */
    k: z.number().int().min(1).default(3),
    problems: z.array(ProblemSchema).min(1),
    personas: z.array(PersonaSchema).min(1),
  })
  .superRefine((s, ctx) => {
    const ids = new Set(s.personas.map((p) => p.id));
    if (ids.size !== s.personas.length) ctx.addIssue({ code: "custom", message: "duplicate persona id" });
    const problemIds = new Set(s.problems.map((p) => p.id));
    if (problemIds.size !== s.problems.length)
      ctx.addIssue({ code: "custom", message: "duplicate problem id" });
    for (const p of s.problems)
      for (const who of p.plantedIn)
        if (!ids.has(who))
          ctx.addIssue({ code: "custom", message: `problem ${p.id} names unknown persona ${who}` });
  });

export type Scenario = z.infer<typeof ScenarioSchema>;
export type Problem = Scenario["problems"][number];
export type Persona = Scenario["personas"][number];

export function parseScenario(raw: unknown): Scenario {
  return ScenarioSchema.parse(raw);
}

export function loadScenario(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")) as unknown);
}

/** The problem ids a persona carries, from the problems' `plantedIn` lists. */
export function plantedFor(scenario: Scenario, personaId: string): Problem[] {
  return scenario.problems.filter((p) => p.plantedIn.includes(personaId));
}

const LENGTH: Record<Persona["talkativeness"], string> = {
  terse:
    "You are terse: one short sentence or a fragment per answer. Give a number or a concrete detail only when asked for it directly.",
  normal: "You answer in two to four plain sentences, with a concrete example when it helps.",
  talkative:
    "You are talkative: four to six sentences, with examples and numbers, and you sometimes add context nobody asked for.",
};

/** The system prompt for the persona simulator. Deterministic for a given scenario and persona. */
export function personaSystemPrompt(scenario: Scenario, persona: Persona): string {
  const lang =
    persona.language === "fi"
      ? "Always answer in Finnish (suomeksi), whatever language the interviewer uses."
      : "Answer in English.";
  return [
    `You are role-playing ${persona.name}, an employee of ${scenario.company.name}, ${scenario.company.description}.`,
    `You are being interviewed by an AI interviewer about how your work is done day to day. Your role: ${persona.role}, ${persona.department}.`,
    `Your attitude: ${persona.attitudes}`,
    "What you know (use ONLY this material; when asked for a detail it does not cover, give a small plausible specific that is consistent with it, or say you do not know):",
    ...persona.facts.map((f) => `- ${f}`),
    "Rules:",
    `- ${LENGTH[persona.talkativeness]}`,
    `- ${lang}`,
    "- Answer only what was asked. Reveal your material gradually as the questions reach it; do not recite it all at once.",
    "- Speak in the first person as yourself. Never mention being an AI, a simulation or a role-play. No stage directions, labels or quotation marks.",
    "- If the interviewer offers answer options, answer in words and say which option fits and why.",
    "- Do not invent problems that are not in your material. If something works well for you, say so.",
  ].join("\n");
}
