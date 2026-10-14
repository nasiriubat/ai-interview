import { createHash } from "node:crypto";
import type { DiffLine, InterviewTemplate } from "@aidp/shared";
import { UNTRUSTED_RULES } from "../../util/untrusted.js";
import { renderSystemPrompt } from "../context.js";
import { TURN_MARKER } from "../turn-parser.js";
import { SHIPPED_PROMPTS, type PromptDefinition } from "./index.js";

/*
 * Prompt administration, the pure half (blueprint feature 5, D-230 to D-235).
 *
 * A tenant may replace a shipped prompt, but the engine and the parsers still depend on what the
 * prompt tells the model to produce, and the safety of a participant's words depends on the
 * instruction hierarchy staying in it. So an edit is only accepted when it keeps:
 *   - every placeholder the shipped prompt has, and invents none (an unknown `{{x}}` would reach
 *     the model verbatim);
 *   - the untrusted-block rules, whole, where the shipped prompt carries them;
 *   - the output contract tokens the parsers read (the TURN marker and the field names).
 * Nothing here talks to a database or a model.
 */

/** Longest body a tenant may store; the shipped prompts are 0.7k to 6.4k characters. */
export const MAX_PROMPT_CHARS = 30_000;

export interface PromptContract {
  key: string;
  /** Placeholders the engine fills; each must stay. */
  requiredPlaceholders: string[];
  /** The instruction-hierarchy paragraph: required whole when the shipped body carries it. */
  untrustedRules: boolean;
  /** Strings the parsers and the engine depend on; each must stay. */
  contractTokens: string[];
  maxChars: number;
}

/** Output contract tokens that cannot be derived from the shipped body alone. */
const EXTRA_TOKENS: Record<string, string[]> = {
  interviewer: ['"areaKey"', '"stateDelta"', '"endInterview"', '"widget"'],
  turn_meta_repair: ['"areaKey"', '"stateDelta"'],
  recap: ['"recap"'],
  clustering: ["merges", "names"],
  issues: ['"findings"'],
  spec: ['"sections"', '"markdown"'],
};

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export const placeholdersOf = (body: string): string[] => [
  ...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]).filter((m): m is string => m !== undefined)),
];

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** The contract a tenant version of `key` must keep, derived from the shipped body plus a short table. */
export function promptContract(key: string): PromptContract | undefined {
  const shipped = SHIPPED_PROMPTS[key];
  if (!shipped) return undefined;
  const tokens = [...(EXTRA_TOKENS[key] ?? [])];
  if (shipped.body.includes(TURN_MARKER)) tokens.unshift(TURN_MARKER);
  return {
    key,
    requiredPlaceholders: placeholdersOf(shipped.body),
    untrustedRules: squash(shipped.body).includes(squash(UNTRUSTED_RULES)),
    contractTokens: tokens,
    maxChars: MAX_PROMPT_CHARS,
  };
}

export type PromptIssueCode =
  | "unknown_prompt"
  | "empty"
  | "too_long"
  | "missing_placeholder"
  | "unknown_placeholder"
  | "missing_untrusted_rules"
  | "missing_contract_token";

export interface PromptIssue {
  code: PromptIssueCode;
  /** The placeholder or token concerned, when there is one. */
  detail?: string;
  message: string;
}

/** Every reason this body cannot replace the shipped prompt; empty means it can. */
export function validatePromptBody(key: string, body: string): PromptIssue[] {
  const contract = promptContract(key);
  if (!contract) return [{ code: "unknown_prompt", message: `There is no prompt called '${key}'.` }];
  const issues: PromptIssue[] = [];
  if (body.trim() === "") return [{ code: "empty", message: "The prompt is empty." }];
  if (body.length > contract.maxChars)
    issues.push({
      code: "too_long",
      message: `The prompt is ${String(body.length)} characters; the limit is ${String(contract.maxChars)}.`,
    });
  const present = new Set(placeholdersOf(body));
  for (const p of contract.requiredPlaceholders)
    if (!present.has(p))
      issues.push({
        code: "missing_placeholder",
        detail: `{{${p}}}`,
        message: `The placeholder {{${p}}} is missing. The engine fills it in for every interview.`,
      });
  for (const p of present)
    if (!contract.requiredPlaceholders.includes(p))
      issues.push({
        code: "unknown_placeholder",
        detail: `{{${p}}}`,
        message: `{{${p}}} is not a placeholder this prompt receives, so it would reach the model as written.`,
      });
  if (contract.untrustedRules && !squash(body).includes(squash(UNTRUSTED_RULES)))
    issues.push({
      code: "missing_untrusted_rules",
      message:
        "The paragraph that tells the model participant text is quoted material, never instructions, is missing or changed. Keep it word for word.",
    });
  for (const token of contract.contractTokens)
    if (!body.includes(token))
      issues.push({
        code: "missing_contract_token",
        detail: token,
        message: `${token} is missing. The output format the engine parses depends on it.`,
      });
  return issues;
}

// ---------- sticky canary assignment ----------

/** A stable number in [0, 1) for this session and prompt key (D-230). */
export function stickyBucket(stickyKey: string, promptKey: string): number {
  const h = createHash("sha256").update(`${promptKey}\u0000${stickyKey}`).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

export interface PromptRowLike {
  companyId: string | null;
  version: number;
  body: string;
  canaryShare: number;
  active: boolean;
}

const isCanary = (r: PromptRowLike): boolean => r.canaryShare > 0 && r.canaryShare < 1;
const isStable = (r: PromptRowLike): boolean => r.canaryShare === 0 || r.canaryShare >= 1;

/**
 * Picks from one owner's active rows. A canary takes its share of sessions, decided by the sticky
 * key when there is one (random otherwise, which is only for calls with no session or campaign);
 * everything else gets the stable version, or nothing, in which case the caller falls through to
 * the next owner.
 */
export function pickFromRows(
  key: string,
  rows: PromptRowLike[],
  source: "tenant" | "platform",
  stickyKey: string | undefined,
  random: () => number,
): PromptDefinition | undefined {
  const active = rows.filter((r) => r.active).sort((a, b) => b.version - a.version);
  const canary = active.find(isCanary);
  if (canary) {
    const roll = stickyKey !== undefined ? stickyBucket(stickyKey, key) : random();
    if (roll < canary.canaryShare) return { key, version: canary.version, body: canary.body, source };
  }
  const stable = active.find(isStable);
  return stable ? { key, version: stable.version, body: stable.body, source } : undefined;
}

// ---------- diff ----------

/** Added and removed line counts of a diff made by `lineDiff` (spec/diff.ts). */
export const promptDiffStats = (lines: DiffLine[]): { added: number; removed: number } => ({
  added: lines.filter((l) => l.type === "add").length,
  removed: lines.filter((l) => l.type === "del").length,
});

// ---------- in-process evaluation ----------

export interface PromptCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface PromptEvaluation {
  ok: boolean;
  checks: PromptCheck[];
}

/** The longest rendered interviewer prompt that still leaves room for context; a tripwire, not a budget. */
export const MAX_RENDERED_INTERVIEWER_CHARS = 40_000;

/**
 * What can be checked about an edited prompt without a model (D-234). The contract checks apply to
 * every prompt; for the interviewer the body is also rendered for each template given, the way
 * every interview renders it, and the result is inspected. This does not judge how well the
 * model follows the wording: that needs a model-backed eval, so the admin starts as a canary.
 */
export function evaluatePrompt(
  key: string,
  body: string,
  templates: InterviewTemplate[] = [],
): PromptEvaluation {
  const checks: PromptCheck[] = [];
  const issues = validatePromptBody(key, body);
  checks.push({
    id: "contract",
    ok: issues.length === 0,
    detail:
      issues.length === 0
        ? "Placeholders, untrusted rules and output contract are intact."
        : issues.map((i) => i.message).join(" "),
  });
  if (key === "interviewer" && issues.length === 0) {
    const def: PromptDefinition = { key, version: 0, body, source: "tenant" };
    for (const t of templates) {
      const rendered = renderSystemPrompt(def, t);
      const left = placeholdersOf(rendered);
      checks.push({
        id: `render:${t.key}`,
        ok: left.length === 0 && rendered.length <= MAX_RENDERED_INTERVIEWER_CHARS,
        detail:
          left.length > 0
            ? `Placeholders left after rendering for '${t.key}': ${left.map((p) => `{{${p}}}`).join(", ")}.`
            : rendered.length > MAX_RENDERED_INTERVIEWER_CHARS
              ? `Rendered prompt for '${t.key}' is ${String(rendered.length)} characters.`
              : `Renders for '${t.key}' (${String(rendered.length)} characters).`,
      });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}
