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
