import { describe, expect, it } from "vitest";
import { en } from "@/i18n/en";
import { fi } from "@/i18n/fi";

/*
 * Finnish runs long: 58 strings were more than 1.5 times their English original (copy audit
 * section 3). jsdom has no layout, so this cannot measure a button on a 360 px screen; it holds
 * the strings that sit on buttons, tabs, tiles and column headers to a character budget that
 * fits at that width, so a later edit that doubles one fails here before a person sees it wrap.
 */

type Strings = typeof en;

function pick(root: Strings, path: string): string {
  let node: unknown = root;
  for (const part of path.split(".")) node = (node as Record<string, unknown>)[part];
  if (typeof node !== "string") throw new Error(`${path} is not a string`);
  return node;
}

const BUTTONS_MAX = 30;
const HEADERS_MAX = 28;

const BUTTONS = [
  "auth.sendLink",
  "auth.google",
  "participant.arrival.start",
  "participant.arrival.resume",
  "participant.verify.sendCode",
  "participant.verify.confirm",
  "participant.verify.resend",
  "participant.verify.changeEmail",
  "participant.consent.start",
  "participant.path.choose",
  "participant.session.send",
  "participant.session.pause",
  "participant.session.resumeNow",
  "participant.session.done",
  "participant.session.doneConfirm",
  "participant.session.deleteData",
  "participant.session.deleteConfirm",
  "participant.session.widgetSubmit",
  "participant.session.typeInstead",
  "participant.session.skipArea",
  "participant.session.returnToArea",
  "participant.session.liveStart",
  "participant.session.liveEnd",
  "participant.session.liveStopSpeaking",
  "participant.session.liveMute",
  "participant.session.liveUnmute",
  "participant.session.liveTypeInstead",
  "participant.session.liveShowConversation",
  "participant.session.liveHideConversation",
  "participant.session.listen",
  "participant.session.recordStart",
];

const HEADERS = [
  "admin.templates.fields.maxTurns",
  "admin.templates.fields.areaMaxFollowUps",
  "admin.campaigns.maxTurns",
  "admin.dashboard.kpi.activeInterviews",
  "admin.dashboard.kpi.completed",
  "admin.results.card.note",
  "admin.dashboard.rank",
  "admin.dashboard.class",
  "admin.dashboard.purpose",
  "admin.nav.dashboard",
  "admin.nav.routes",
  "admin.nav.providers",
  "admin.nav.budgets",
  "admin.nav.audit",
  "admin.nav.operator",
];

describe("Finnish strings that sit on buttons and headers stay short", () => {
  it.each(BUTTONS)("button %s", (path) => {
    expect(pick(fi, path).length).toBeLessThanOrEqual(BUTTONS_MAX);
  });

  it.each(HEADERS)("header or tile %s", (path) => {
    expect(pick(fi, path).length).toBeLessThanOrEqual(HEADERS_MAX);
  });

  it("every listed key exists in English too, so the budget is checked against a real original", () => {
    for (const path of [...BUTTONS, ...HEADERS]) expect(pick(en, path).length).toBeGreaterThan(0);
  });
});

describe("empty states do not repeat their title", () => {
  // Found in the 2026-10-15 simulation: "No campaigns yet" over "No campaigns yet. Create one ...".
  function pairs(node: unknown, path: string, out: [string, string, string][]): void {
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (typeof o.emptyTitle === "string" && typeof o.empty === "string")
      out.push([path, o.emptyTitle, o.empty]);
    for (const [k, v] of Object.entries(o)) pairs(v, path ? `${path}.${k}` : k, out);
  }
  it.each([
    ["en", en],
    ["fi", fi],
  ] as const)("%s", (_l, strings) => {
    const found: [string, string, string][] = [];
    pairs(strings, "", found);
    expect(found.length).toBeGreaterThan(0);
    const repeating = found.filter(([, title, body]) => body.toLowerCase().startsWith(title.toLowerCase()));
    expect(repeating.map(([p]) => p)).toEqual([]);
  });
});

describe("weekly time on an opportunity (simulation 2026-10-15)", () => {
  it("says nothing was stated instead of 0, and hours instead of thousands of minutes", () => {
    expect(en.ws.opportunity.minutes(0)).toBe("No time stated");
    expect(en.ws.opportunity.minutes(45)).toBe("45 min per week");
    expect(en.ws.opportunity.minutes(3285)).toBe("About 55 h per week");
    expect(fi.ws.opportunity.minutes(0)).toBe("Aikaa ei mainittu");
  });
});

describe("a withheld department cell (simulation 2026-10-15)", () => {
  it("says the share has too few people behind it, not that the group did", () => {
    // A department of three showed "Fewer than 3 people in this group answered".
    expect(en.ws.departments.cellReason(3)).toMatch(/behind this share/);
    expect(en.ws.departments.cellReason(3)).not.toMatch(/in this group answered/);
  });
});

describe("a running analysis is not always the admin's own edit (simulation 2026-10-15)", () => {
  it("does not say 'your change' for an automatic run", () => {
    expect(en.admin.results.reanalysing).not.toMatch(/your change/i);
    expect(fi.admin.results.reanalysing).not.toMatch(/muutoksesi/);
  });
});

describe("the promote dialog says what is carried over (claims C5)", () => {
  // Simulation 2026-10-15: it promised "the brief below" and showed only the title.
  it("names the starting brief instead of pointing at one that is not shown", () => {
    expect(en.admin.results.promote.body).toMatch(/starting brief/);
    expect(en.admin.results.promote.body).not.toMatch(/brief below/);
    expect(fi.admin.results.promote.body).toMatch(/lähtötiedoiksi/);
  });
});
