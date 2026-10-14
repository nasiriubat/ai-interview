import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as f from "../e2e/fixtures";
import { NOT_DOCUMENTS, NOT_YET, PAGES } from "../e2e/pages";
import {
  AnalysisSchema,
  CampaignSchema,
  InvitationSchema,
  LinkInfoSchema,
  MeSchema,
  ParticipantSessionSchema,
  SessionListItemSchema,
  TemplateRecordSchema,
} from "@/lib/api/schemas";

/*
 * The browser pass (`pnpm --filter @aidp/web e2e`) cannot run here, so what can be checked without
 * a browser is: every page has an entry, and the fixtures it renders from are still the shapes the
 * web app parses.
 */

const SRC = path.resolve(import.meta.dirname, "../src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = path.join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

describe("page inventory", () => {
  const routes = walk(path.join(SRC, "app"))
    .map((p) => path.relative(path.resolve(SRC, ".."), p).replace(/^src\//, ""))
    .filter((p) => /(page|route|layout|error|not-found)\.tsx?$/.test(p));

  it("has an entry, a stated reason or a note for every route under src/app", () => {
    const covered = new Set([...PAGES.map((p) => p.route), ...NOT_DOCUMENTS, ...Object.keys(NOT_YET)]);
    const files = routes.map((r) => `app/${r.replace(/^app\//, "")}`);
    expect(files.filter((r) => !covered.has(r))).toEqual([]);
  });

  it("names no route that no longer exists", () => {
    const files = new Set(routes.map((r) => `app/${r.replace(/^app\//, "")}`));
    const named = [...PAGES.map((p) => p.route), ...Object.keys(NOT_YET)];
    expect(named.filter((r) => !files.has(r))).toEqual([]);
  });

  it("gives every entry a unique id and every non-document route no entry", () => {
    const ids = PAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("fixtures are the shapes the pages parse", () => {
  it("parses the staff, campaign and template records", () => {
    expect(() => MeSchema.parse(f.me())).not.toThrow();
    expect(() => CampaignSchema.parse(f.campaign)).not.toThrow();
    expect(() => TemplateRecordSchema.parse(f.template)).not.toThrow();
    for (const i of f.invitations) expect(() => InvitationSchema.parse(i)).not.toThrow();
    for (const s of f.sessions) expect(() => SessionListItemSchema.parse(s)).not.toThrow();
    expect(() => AnalysisSchema.parse(f.analysis)).not.toThrow();
  });

  it("parses the participant link and session", () => {
    for (const s of ["open", "closed", "expired"] as const)
      expect(() => LinkInfoSchema.parse(f.linkInfo(s))).not.toThrow();
    const session = ParticipantSessionSchema.parse(f.participantSession);
    expect(session.messages.at(-1)?.widget?.type).toBe("single_choice");
  });
});
