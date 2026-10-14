import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockIsHeld, parseDotenv, redactSecrets, resolveRunConfig, type ListedModel } from "./pure.js";

/** Repository root of the worktree this harness runs in. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RUN = resolveRunConfig(process.env, tmpdir());
/** `default`, or LIVE_RUN_ID: every name below carries it so concurrent runs cannot collide. */
export const RUN_ID = RUN.runId;
const OUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../out");
export const OUT_DIR = RUN.outSubdir ? join(OUT_ROOT, RUN.outSubdir) : OUT_ROOT;

export const API_PORT = RUN.apiPort;
export const API_BASE = `http://127.0.0.1:${API_PORT}/api/v1`;
export const DB_NAME = RUN.dbName;
export const PG_CONTAINER = process.env.LIVE_PG_CONTAINER ?? "ai-interview-postgres-1";
/** Hard ceiling for everything this run spends, product ledger plus the harness's own calls. */
export const TOTAL_CAP_CENTS = Number(process.env.LIVE_TOTAL_CAP_CENTS ?? 380);
/** The tenant budget set through the product's own budget feature. */
export const TENANT_BUDGET_CENTS = Number(process.env.LIVE_TENANT_BUDGET_CENTS ?? 400);

/** Scratch directory for child-process logs, kept outside the repository. */
export const SCRATCH_DIR = RUN.scratchDir;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * One run per database name at a time. A second run with the same names would DROP the first
 * run's database under it, so it is refused with the way out. A lock whose pid is dead is taken over.
 */
export function acquireRunLock(): void {
  const path = join(tmpdir(), `ai-discovery-live-${DB_NAME}.lock`);
  if (existsSync(path)) {
    const content = readFileSync(path, "utf8");
    if (lockIsHeld(content, pidAlive)) {
      throw new Error(
        `another live run is using database ${DB_NAME} (lock ${path}, pid ${content.trim()}). ` +
          `Set LIVE_RUN_ID=<name> to run beside it (own database, port, scratch and out/<name>/).`,
      );
    }
  }
  writeFileSync(path, `${process.pid}\n`);
  const release = (): void => {
    try {
      rmSync(path, { force: true });
    } catch {
      /* nothing to do */
    }
  };
  process.on("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      release();
      process.exit(130);
    });
  }
}

/** Set by the budget watcher; every long loop checks it between turns. */
export const abortState: { reason: string | null } = { reason: null };

const secrets: string[] = [];

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8 && !secrets.includes(value)) secrets.push(value);
}

export function redact(text: string): string {
  return redactSecrets(text, secrets);
}

export function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  console.warn(`[${stamp}] ${redact(message)}`);
}

export function ensureDir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

/** Writes an artifact under out/, redacting anything that looks like a secret on the way. */
export function writeArtifact(relative: string, content: string): string {
  const target = join(OUT_DIR, relative);
  ensureDir(dirname(target));
  writeFileSync(target, redact(content));
  return target;
}

export function writeJson(relative: string, value: unknown): string {
  return writeArtifact(relative, JSON.stringify(value, null, 2));
}

/**
 * Finds OPENROUTER_API_KEY. Read only inside this process: from the environment, or from the
 * first `.env` (the root file, D-400) or legacy `apps/api/.env` found walking up from the worktree (a worktree has none of its
 * own because `.env` files are never copied). The value is registered for redaction and is only
 * ever handed to child processes through their environment, never written anywhere.
 */
export function loadOpenRouterKey(): string {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv) {
    registerSecret(fromEnv);
    return fromEnv;
  }
  const explicit = process.env.LIVE_ENV_FILE ? [resolve(process.env.LIVE_ENV_FILE)] : [];
  const candidates = [...explicit];
  let dir = REPO_ROOT;
  for (let i = 0; i < 8; i++) {
    candidates.push(join(dir, ".env"), join(dir, "apps/api/.env"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const key = parseDotenv(readFileSync(file, "utf8")).OPENROUTER_API_KEY;
    if (key) {
      registerSecret(key);
      return key;
    }
  }
  throw new Error("OPENROUTER_API_KEY not found in the environment or in any .env above the worktree");
}

// ---------------------------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------------------------

interface RawModel {
  id: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number | null };
}

/** The public model list (no key needed), mapped to prices per million tokens. */
export async function listModels(): Promise<ListedModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`OpenRouter model list failed: ${res.status}`);
  const body = (await res.json()) as { data: RawModel[] };
  return body.data.flatMap((m) => {
    const input = Number(m.pricing?.prompt ?? Number.NaN) * 1_000_000;
    const output = Number(m.pricing?.completion ?? Number.NaN) * 1_000_000;
    if (!Number.isFinite(input) || !Number.isFinite(output)) return [];
    const out = m.architecture?.output_modalities ?? [];
    return [
      {
        id: m.id,
        contextLength: m.context_length ?? 0,
        inputPerMtok: input,
        outputPerMtok: output,
        maxCompletionTokens: m.top_provider?.max_completion_tokens ?? null,
        supportsStructured: (m.supported_parameters ?? []).includes("structured_outputs"),
        textOnly: out.length === 1 && out[0] === "text",
      },
    ];
  });
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  ms: number;
}

/** Cost of the harness's own model calls (simulated participants and the judge). */
export const harnessSpend = {
  usd: 0,
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  byLabel: {} as Record<string, number>,
};

/** Direct OpenRouter chat call for the simulators and the judge: outside the product on purpose. */
export async function chat(opts: {
  apiKey: string;
  model: string;
  label: string;
  messages: ChatMessage[];
  maxTokens?: number;
  json?: boolean;
  temperature?: number;
}): Promise<ChatResult> {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          max_tokens: opts.maxTokens ?? 600,
          temperature: opts.temperature ?? 0.8,
          usage: { include: true },
          ...(opts.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
          await sleep(1500 * (attempt + 1));
          continue;
        }
        throw new Error(`OpenRouter ${res.status}: ${redact(text)}`);
      }
      const body = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      const result: ChatResult = {
        content: body.choices?.[0]?.message?.content ?? "",
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
        costUsd: body.usage?.cost ?? 0,
        ms: Date.now() - started,
      };
      harnessSpend.usd += result.costUsd;
      harnessSpend.calls += 1;
      harnessSpend.promptTokens += result.promptTokens;
      harnessSpend.completionTokens += result.completionTokens;
      harnessSpend.byLabel[opts.label] = (harnessSpend.byLabel[opts.label] ?? 0) + result.costUsd;
      return result;
    } catch (err) {
      if (attempt < 3 && !(err instanceof Error && err.message.startsWith("OpenRouter 4"))) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

/** Usage in USD the OpenRouter account has accrued on this key, for a before/after delta. */
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
