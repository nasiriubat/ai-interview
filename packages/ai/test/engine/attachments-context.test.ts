import { SessionStateSchema, type InterviewTemplate } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { renderState } from "../../src/engine/context.js";
import type { SessionSnapshot } from "../../src/engine/ports.js";

/**
 * An attached file is only worth anything if the interviewer knows it is there. These assert the
 * contract between ingestion and the prompt: the summary rides along every turn, the wording does
 * not, and a file that could not be read says so rather than looking like an empty one.
 */

const template = {
  key: "t",
  version: 1,
  name: "T",
  language: "en",
  objective: "o",
  privacyMode: "anonymous",
  participantFields: [],
  coverageAreas: [{ key: "daily", name: "Daily work", goal: "g", required: true }],
  aiInstructions: "",
  adaptivity: {},
  widgetPolicy: {},
  outputs: {},
  endSummary: true,
} as unknown as InterviewTemplate;

// The schema's own defaults rather than a hand-written literal: a partial fixture would only
// prove that renderState crashes on it, which is not what these tests are about.
const state = SessionStateSchema.parse({});

const attached = (over: Partial<NonNullable<SessionSnapshot["attachments"]>[number]>) => [
  {
    filename: "ward-procedure.pdf",
    kind: "document",
    summary: "Referrals arrive by fax and are retyped into the ward spreadsheet.",
    status: "ready",
    ...over,
  },
];

describe("attachments in the interviewer's context", () => {
  it("says nothing at all when nothing is attached", () => {
    expect(renderState(state, template, undefined, undefined, undefined)).not.toContain("attached");
    expect(renderState(state, template, undefined, undefined, [])).not.toContain("attached");
  });

  it("carries the file name and its summary", () => {
    const out = renderState(state, template, undefined, undefined, attached({}));

    expect(out).toContain("ward-procedure.pdf");
    expect(out).toContain("Referrals arrive by fax");
  });

  it("tells the interviewer a file is still being read, so it does not claim to have seen it", () => {
    const out = renderState(
      state,
      template,
      undefined,
      undefined,
      attached({ status: "pending", summary: "" }),
    );

    expect(out).toContain("still being read");
  });

  it("says a file could not be read, and what to do instead", () => {
    // The worst outcome here is silence: an unreadable scan that looks like an empty document
    // means the interviewer never asks about the thing the participant went to the trouble of
    // attaching.
    const out = renderState(
      state,
      template,
      undefined,
      undefined,
      attached({ status: "failed", summary: "" }),
    );

    expect(out).toContain("could not be read");
    expect(out).toContain("ask them what is in it");
  });

  it("instructs the interviewer not to ask for facts the file already contains", () => {
    const out = renderState(state, template, undefined, undefined, attached({}));

    expect(out).toMatch(/rather than asking for facts they already contain/i);
  });

  it("lists several files", () => {
    const out = renderState(state, template, undefined, undefined, [
      ...attached({}),
      {
        filename: "rota.xlsx",
        kind: "document",
        summary: "A weekly rota, filled in by hand.",
        status: "ready",
      },
    ]);

    expect(out).toContain("ward-procedure.pdf");
    expect(out).toContain("rota.xlsx");
  });
});
