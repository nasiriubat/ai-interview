import {
  describeEvaluationFailure,
  evaluatePrompt,
  lineDiff,
  promptDiffStats,
  pickFromRows,
  promptContract,
  promptVersionTag,
  SHIPPED_PROMPTS,
  type PromptContract,
  type PromptDefinition,
  type PromptEvaluation,
} from "@aidp/ai";
import { shippedTemplates, tenantTransaction } from "@aidp/db";
import type { DiffLine } from "@aidp/shared";
import type { PrismaClient, PromptVersion } from "@prisma/client";
import { AppError, notFound } from "../../lib/errors.js";

/**
 * Prompt administration (blueprint feature 5, D-230 to D-235).
 *
 * A tenant version is a row of `PromptVersion` owned by the company. At most one is the stable
 * version (active, share 1) and at most one the canary (active, 0 < share < 1). The shipped file
 * is code: it is never edited, it is the permanent reset target, and it is what runs when the
 * tenant has nothing active. Rows are never deleted, so every version stays diffable.
 *
 * Platform rows (`companyId` null) are managed by the operator elsewhere; this service lists them
 * so a tenant can see why its effective prompt is not the shipped one, and never writes them.
 */

export type PromptGroup = "interview" | "analysis" | "requirements" | "files";

export const PROMPT_GROUPS: Record<string, PromptGroup> = {
  interviewer: "interview",
  summary: "interview",
  recap: "interview",
  turn_meta_repair: "interview",
  extraction: "interview",
  clustering: "analysis",
  opportunity: "analysis",
  report: "analysis",
  issues: "requirements",
  spec: "requirements",
  file_summary: "files",
  image_describe: "files",
};

/** Ledger rows older than this are left out of the per-version figures. */
export const STATS_WINDOW_DAYS = 30;
/** Versions a tenant may keep per key; history is kept, so there is a ceiling. */
export const MAX_VERSIONS_PER_KEY = 100;

export interface VersionStats {
  calls: number;
  errors: number;
  /** errors / calls, 0 when there are no calls. */
  errorRate: number;
  meanLatencyMs: number;
  meanCostCents: number;
}

export type VersionState = "stable" | "canary" | "inactive";

export interface EffectiveView {
  source: "shipped" | "platform" | "tenant";
  version: number;
  tag: string;
}

export interface VersionView {
  version: number;
  tag: string;
  note: string | null;
  body: string;
  state: VersionState;
  canaryShare: number;
  parentVersion: number | null;
  createdAt: Date;
  createdBy: { id: string; name: string | null; email: string } | null;
  activatedAt: Date | null;
  deactivatedAt: Date | null;
  stats: VersionStats;
}

export interface PromptSummary {
  key: string;
  group: PromptGroup;
  shipped: { version: number; tag: string; chars: number };
  effective: EffectiveView;
  canary: { version: number; share: number } | null;
  versions: number;
  stats: VersionStats;
}

export interface PromptDetail {
  key: string;
  group: PromptGroup;
  shipped: { version: number; tag: string; body: string; stats: VersionStats };
  contract: PromptContract;
  effective: EffectiveView;
  canary: { version: number; share: number } | null;
  /** An active platform version the tenant inherits when it has none of its own. */
  platform: { version: number } | null;
  versions: VersionView[];
  windowDays: number;
}

export interface DiffView {
  from: string;
  to: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}

const EMPTY_STATS: VersionStats = { calls: 0, errors: 0, errorRate: 0, meanLatencyMs: 0, meanCostCents: 0 };

const stateOf = (r: Pick<PromptVersion, "active" | "canaryShare">): VersionState =>
  !r.active ? "inactive" : r.canaryShare > 0 && r.canaryShare < 1 ? "canary" : "stable";

const shippedOf = (key: string): PromptDefinition => {
  const p = SHIPPED_PROMPTS[key];
  if (!p) throw notFound("Prompt");
  return p;
};

const contractOf = (key: string): PromptContract => {
  const c = promptContract(key);
  if (!c) throw notFound("Prompt");
  return c;
};

export class PromptAdminService {
  constructor(
    private readonly db: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private assertKey(key: string): void {
    if (!SHIPPED_PROMPTS[key]) throw notFound("Prompt");
  }

  /** Ledger figures by `promptVersion` tag for this tenant, over the window. */
  private async statsByTag(companyId: string, tags?: string[]): Promise<Map<string, VersionStats>> {
    const since = new Date(this.now().getTime() - STATS_WINDOW_DAYS * 86_400_000);
    const rows = await this.db.llmCall.groupBy({
      by: ["promptVersion", "status"],
      where: {
        companyId,
        createdAt: { gte: since },
        ...(tags ? { promptVersion: { in: tags } } : { promptVersion: { not: null } }),
      },
      _count: { _all: true },
      _avg: { latencyMs: true, costCents: true },
    });
    const sums = new Map<string, { calls: number; errors: number; latency: number; cost: number }>();
    for (const r of rows) {
      if (r.promptVersion === null) continue;
      const s = sums.get(r.promptVersion) ?? { calls: 0, errors: 0, latency: 0, cost: 0 };
      const n = r._count._all;
      s.calls += n;
      if (r.status === "error" || r.status === "refused") s.errors += n;
      s.latency += (r._avg.latencyMs ?? 0) * n;
      s.cost += (r._avg.costCents ?? 0) * n;
      sums.set(r.promptVersion, s);
    }
    return new Map(
      [...sums].map(([tag, s]) => [
        tag,
        {
          calls: s.calls,
          errors: s.errors,
          errorRate: s.calls ? s.errors / s.calls : 0,
          meanLatencyMs: s.calls ? Math.round(s.latency / s.calls) : 0,
          meanCostCents: s.calls ? s.cost / s.calls : 0,
        },
      ]),
    );
  }

  /** Every key's rows that this tenant can see: its own and the platform's active ones. */
  private rowsFor(companyId: string, key?: string): Promise<PromptVersion[]> {
    return this.db.promptVersion.findMany({
      where: {
        ...(key ? { key } : {}),
        OR: [{ companyId }, { companyId: null, active: true }],
      },
      orderBy: { version: "desc" },
    });
  }

  private effective(key: string, rows: PromptVersion[], companyId: string): EffectiveView {
    // Non-canary sessions: the stable row only, which is what most sessions get.
    const stable = (list: PromptVersion[], source: "tenant" | "platform") =>
      pickFromRows(
        key,
        list.filter((r) => stateOf(r) !== "canary"),
        source,
        undefined,
        () => 1,
      );
    const own = stable(
      rows.filter((r) => r.companyId === companyId),
      "tenant",
    );
    const plat = own
      ? undefined
      : stable(
          rows.filter((r) => r.companyId === null),
          "platform",
        );
    const p = own ?? plat ?? shippedOf(key);
    return {
      source: own ? "tenant" : plat ? "platform" : "shipped",
      version: p.version,
      tag: promptVersionTag(p),
    };
  }

  async list(companyId: string): Promise<PromptSummary[]> {
    const [rows, stats] = await Promise.all([this.rowsFor(companyId), this.statsByTag(companyId)]);
    return Object.keys(SHIPPED_PROMPTS).map((key) => {
      const shipped = shippedOf(key);
      const mine = rows.filter((r) => r.key === key);
      const eff = this.effective(key, mine, companyId);
      const canary = mine.find((r) => r.companyId === companyId && stateOf(r) === "canary");
      return {
        key,
        group: PROMPT_GROUPS[key] ?? "interview",
        shipped: { version: shipped.version, tag: promptVersionTag(shipped), chars: shipped.body.length },
        effective: eff,
        canary: canary ? { version: canary.version, share: canary.canaryShare } : null,
        versions: mine.filter((r) => r.companyId === companyId).length,
        stats: stats.get(eff.tag) ?? EMPTY_STATS,
      };
    });
  }

  async get(companyId: string, key: string): Promise<PromptDetail> {
    this.assertKey(key);
    const shipped = shippedOf(key);
    const [rows, stats] = await Promise.all([this.rowsFor(companyId, key), this.statsByTag(companyId)]);
    const own = rows.filter((r) => r.companyId === companyId);
    const authorIds = [...new Set(own.map((r) => r.createdBy).filter((v): v is string => v !== null))];
    const authors = authorIds.length
      ? await this.db.user.findMany({
          where: { id: { in: authorIds }, companyId },
          select: { id: true, name: true, email: true },
        })
      : [];
    const authorOf = new Map(authors.map((a) => [a.id, a]));
    const canary = own.find((r) => stateOf(r) === "canary");
    const platformStable = rows.find((r) => r.companyId === null && stateOf(r) === "stable");
    return {
      key,
      group: PROMPT_GROUPS[key] ?? "interview",
      shipped: {
        version: shipped.version,
        tag: promptVersionTag(shipped),
        body: shipped.body,
        stats: stats.get(promptVersionTag(shipped)) ?? EMPTY_STATS,
      },
      contract: contractOf(key),
      effective: this.effective(key, rows, companyId),
      canary: canary ? { version: canary.version, share: canary.canaryShare } : null,
      platform: platformStable ? { version: platformStable.version } : null,
      versions: own.map((r) => {
        const tag = promptVersionTag({ key, version: r.version, body: "", source: "tenant" });
        return {
          version: r.version,
          tag,
          note: r.note,
          body: r.body,
          state: stateOf(r),
          canaryShare: r.canaryShare,
          parentVersion: r.parentVersion,
          createdAt: r.createdAt,
          createdBy: (r.createdBy ? authorOf.get(r.createdBy) : undefined) ?? null,
          activatedAt: r.activatedAt,
          deactivatedAt: r.deactivatedAt,
          stats: stats.get(tag) ?? EMPTY_STATS,
        };
      }),
      windowDays: STATS_WINDOW_DAYS,
    };
  }

  /** Checks a body without storing it: the contract, and for the interviewer the rendering. */
  check(key: string, body: string): PromptEvaluation {
    this.assertKey(key);
    return evaluatePrompt(key, body, shippedTemplates());
  }

  /** Line diff between two bodies: `shipped`, or a tenant version number. */
  async diff(companyId: string, key: string, from: string, to: string): Promise<DiffView> {
    this.assertKey(key);
    const body = async (ref: string): Promise<string> => {
      if (ref === "shipped") return shippedOf(key).body;
      const v = Number(ref);
      if (!Number.isInteger(v) || v < 1) throw new AppError("validation", `'${ref}' is not a version`);
      const row = await this.db.promptVersion.findFirst({ where: { companyId, key, version: v } });
      if (!row) throw notFound("Prompt version");
      return row.body;
    };
    const lines = lineDiff(await body(from), await body(to));
    return { from, to, lines, ...promptDiffStats(lines) };
  }

  /** A new, inactive version. Nothing changes for participants until it is activated. */
  async create(
    companyId: string,
    key: string,
    input: { body: string; note?: string | undefined; parentVersion?: number | undefined },
    actorId: string,
  ): Promise<VersionView> {
    this.assertKey(key);
    const evaluation = this.check(key, input.body);
    if (!evaluation.ok)
      throw new AppError("validation", describeEvaluationFailure(evaluation), {
        issues: evaluation.issues,
        renders: evaluation.renders,
      });
    const created = await tenantTransaction(this.db, async (tx) => {
      const existing = await tx.promptVersion.findMany({
        where: { companyId, key },
        select: { version: true },
        orderBy: { version: "desc" },
      });
      if (existing.length >= MAX_VERSIONS_PER_KEY)
        throw new AppError("conflict", `A prompt keeps at most ${String(MAX_VERSIONS_PER_KEY)} versions`);
      if (input.parentVersion !== undefined && !existing.some((e) => e.version === input.parentVersion))
        throw notFound("Parent version");
      return tx.promptVersion.create({
        data: {
          companyId,
          key,
          version: (existing[0]?.version ?? 0) + 1,
          body: input.body,
          note: input.note !== undefined && input.note.trim() !== "" ? input.note.trim() : null,
          parentVersion: input.parentVersion ?? null,
          createdBy: actorId,
        },
      });
    });
    return this.view(companyId, key, created.version);
  }

  private async view(companyId: string, key: string, version: number): Promise<VersionView> {
    const detail = await this.get(companyId, key);
    const v = detail.versions.find((x) => x.version === version);
    if (!v) throw notFound("Prompt version");
    return v;
  }

  /**
   * Makes a version the stable one (share 1) or the canary (0 < share < 1). The previous holder of
   * that slot is deactivated, not deleted. The body is checked again here: what was valid when it
   * was written must also be valid against today's contract.
   */
  async activate(
    companyId: string,
    key: string,
    version: number,
    share: number,
  ): Promise<{ version: VersionView; replaced: number | null; share: number }> {
    this.assertKey(key);
    if (!(share > 0 && share <= 1))
      throw new AppError("validation", "The share is a number above 0 and up to 1");
    const row = await this.db.promptVersion.findFirst({ where: { companyId, key, version } });
    if (!row) throw notFound("Prompt version");
    const evaluation = this.check(key, row.body);
    if (!evaluation.ok)
      throw new AppError("validation", describeEvaluationFailure(evaluation), {
        issues: evaluation.issues,
        renders: evaluation.renders,
      });
    const now = this.now();
    const wantsStable = share >= 1;
    let replaced: number | null = null;
    await tenantTransaction(this.db, async (tx) => {
      const active = await tx.promptVersion.findMany({ where: { companyId, key, active: true } });
      for (const other of active) {
        if (other.version === version) continue;
        const otherIsCanary = stateOf(other) === "canary";
        if (otherIsCanary === !wantsStable) {
          // Same slot: the new version takes it.
          await tx.promptVersion.update({
            where: { id: other.id },
            data: { active: false, deactivatedAt: now },
          });
          replaced = other.version;
        }
      }
      await tx.promptVersion.update({
        where: { id: row.id },
        data: { active: true, canaryShare: wantsStable ? 1 : share, activatedAt: now, deactivatedAt: null },
      });
    });
    return { version: await this.view(companyId, key, version), replaced, share: wantsStable ? 1 : share };
  }

  /** Stops the canary; the stable version (or the shipped prompt) takes all sessions again. */
  async stopCanary(companyId: string, key: string): Promise<{ stopped: number }> {
    this.assertKey(key);
    const now = this.now();
    return tenantTransaction(this.db, async (tx) => {
      const canary = (await tx.promptVersion.findMany({ where: { companyId, key, active: true } })).find(
        (r) => stateOf(r) === "canary",
      );
      if (!canary) throw new AppError("conflict", "There is no canary running for this prompt");
      await tx.promptVersion.update({
        where: { id: canary.id },
        data: { active: false, deactivatedAt: now },
      });
      return { stopped: canary.version };
    });
  }

  /**
   * Goes back to the stable version that was in force before the current one: the most recently
   * deactivated stable row. Without one there is nothing to go back to, and `reset` is the way to
   * the shipped prompt.
   */
  async rollback(companyId: string, key: string): Promise<{ from: number | null; to: number }> {
    this.assertKey(key);
    const now = this.now();
    return tenantTransaction(this.db, async (tx) => {
      const rows = await tx.promptVersion.findMany({ where: { companyId, key } });
      const current = rows.find((r) => r.active && stateOf(r) === "stable");
      const previous = rows
        .filter((r) => !r.active && r.canaryShare >= 1 && r.deactivatedAt !== null)
        .sort((a, b) => (b.deactivatedAt?.getTime() ?? 0) - (a.deactivatedAt?.getTime() ?? 0))[0];
      if (!previous) throw new AppError("conflict", "There is no earlier version to go back to");
      if (current)
        await tx.promptVersion.update({
          where: { id: current.id },
          data: { active: false, deactivatedAt: now },
        });
      await tx.promptVersion.update({
        where: { id: previous.id },
        data: { active: true, canaryShare: 1, activatedAt: now, deactivatedAt: null },
      });
      return { from: current?.version ?? null, to: previous.version };
    });
  }

  /** Deactivates every tenant version; the platform or shipped prompt applies again. Rows stay. */
  async reset(companyId: string, key: string): Promise<{ deactivated: number[] }> {
    this.assertKey(key);
    const now = this.now();
    return tenantTransaction(this.db, async (tx) => {
      const active = await tx.promptVersion.findMany({ where: { companyId, key, active: true } });
      for (const r of active)
        await tx.promptVersion.update({ where: { id: r.id }, data: { active: false, deactivatedAt: now } });
      return { deactivated: active.map((r) => r.version) };
    });
  }
}
