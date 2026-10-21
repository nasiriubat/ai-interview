/**
 * Direct OpenRouter calls for the persona simulator and the judge. This is test tooling outside the
 * product: it never goes through ModelCaller on purpose, so its spend never lands in the product's
 * ledger or budgets and the product under test cannot see or influence it (AGENTS.md rule 2 covers
 * product code; see README "Why the harness calls OpenRouter directly").
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDotenv, redactSecrets } from "../../live-run/src/pure.js";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const secrets: string[] = [];
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
}
export function redact(text: string): string {
  return redactSecrets(text, secrets);
}

/** OPENROUTER_API_KEY from the environment, else the first `.env` walking up from this worktree. */
export function loadOpenRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv) {
    registerSecret(fromEnv);
    return fromEnv;
  }
  let dir = REPO_ROOT;
  for (let i = 0; i < 8; i++) {
    const file = join(dir, ".env");
    if (existsSync(file)) {
      const key = parseDotenv(readFileSync(file, "utf8")).OPENROUTER_API_KEY;
      if (key) {
        registerSecret(key);
        return key;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("OPENROUTER_API_KEY not found in the environment or in any .env above the worktree");
}

export interface ModelPrice {
  id: string;
  inputPerMtok: number;
  outputPerMtok: number;
}

/** The public price list (no key needed), per million tokens. */
export async function listPrices(): Promise<Map<string, ModelPrice>> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter model list failed: ${res.status}`);
  const body = (await res.json()) as {
    data: { id: string; pricing?: { prompt?: string; completion?: string } }[];
  };
  const out = new Map<string, ModelPrice>();
  for (const m of body.data) {
    const i = Number(m.pricing?.prompt) * 1e6;
    const o = Number(m.pricing?.completion) * 1e6;
    if (Number.isFinite(i) && Number.isFinite(o))
      out.set(m.id, { id: m.id, inputPerMtok: i, outputPerMtok: o });
  }
  return out;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** What the harness itself has spent, by label prefix (`sim`, `judge`, `observe`). */
export const harnessSpend = { usd: 0, calls: 0, byLabel: {} as Record<string, number> };

/** Thrown between calls once the run's own cap is reached; loops stop at the next check. */
export const abortState: { reason: string | null } = { reason: null };

export async function chat(opts: {
  apiKey: string;
  model: string;
  label: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  seed?: number;
  json?: boolean;
}): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          max_tokens: opts.maxTokens,
          temperature: opts.temperature,
          usage: { include: true },
          // No hidden reasoning: some models (Claude Sonnet 5 on OpenRouter) think by default and
          // spend the whole max_tokens on it, returning empty content; and an answer without
          // sampled reasoning is more repeatable for a judge.
          reasoning: { enabled: false },
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw new Error(`OpenRouter ${res.status}: ${redact(text)}`);
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { cost?: number };
      };
      const cost = body.usage?.cost ?? 0;
      harnessSpend.usd += cost;
      harnessSpend.calls += 1;
      const key = opts.label.split(":")[0] ?? opts.label;
      harnessSpend.byLabel[key] = (harnessSpend.byLabel[key] ?? 0) + cost;
      return body.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      if (attempt < 3 && !(err instanceof Error && err.message.startsWith("OpenRouter 4"))) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/** Total usage in USD on this key so far; the before/after delta is the run's real spend. */
export async function keyUsageUsd(apiKey: string): Promise<number | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { usage?: number } };
    return body.data?.usage ?? null;
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function log(message: string): void {
  console.warn(`[${new Date().toISOString().slice(11, 19)}] ${redact(message)}`);
}

/** Runs tasks with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
