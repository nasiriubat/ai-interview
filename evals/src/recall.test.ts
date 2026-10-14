import { describe, expect, it } from "vitest";
import {
  attributeLoss,
  clusterBootstrap,
  evidenceMatches,
  lostTitles,
  mergedAway,
  matchCapabilities,
  mulberry32,
  precisionRows,
  settleMatches,
  summarize,
  verifyStated,
  wilson,
  type ListedRequirement,
  type StatedCapability,
} from "./recall.js";

const owner = [
  "Nurses type every note twice, once in the patient system and once in a spreadsheet.",
  "I want the handover list printed for the night shift, sorted by bed number.",
  "Please send the supervisor a reminder when a note is more than two hours old.",
];

const req = (id: string, title: string, over: Partial<ListedRequirement> = {}): ListedRequirement => ({
  id,
  title,
  acceptance: [],
  ...over,
});

describe("verifying the extractor's quotes (D-300)", () => {
  it("keeps a capability whose quote is the owner's words", () => {
    const { verified, rejected } = verifyStated(
      [{ text: "Print handover list", quote: "the handover list printed for the night shift" }],
      owner,
    );
    expect(verified).toHaveLength(1);
    expect(verified[0]?.key).toBe("c1");
    expect(rejected).toEqual([]);
  });

  it("drops a quote the owner never said, one that is too short and one without text", () => {
    const { verified, rejected } = verifyStated(
      [
        { text: "Export to PDF", quote: "export every report to a pdf file at midnight" },
        { text: "Print", quote: "printed" },
        { text: "", quote: "nurses type every note twice" },
      ],
      owner,
    );
    expect(verified).toHaveLength(0);
    expect(rejected.map((r) => r.reason)).toEqual([
      "quote not in the owner's words",
      "quote too short",
      "no text",
    ]);
  });

  it("keeps the kind, defaulting to feature", () => {
    const { verified } = verifyStated(
      [
        { text: "Print", quote: "the handover list printed for the night shift", kind: "feature" },
        {
          text: "Reminders",
          quote: "send the supervisor a reminder when a note is more than two hours old",
          kind: "constraint",
        },
        { text: "Both", quote: "type every note twice, once in the patient system" },
      ],
      owner,
    );
    expect(verified.map((v) => v.kind)).toEqual(["feature", "constraint", "feature"]);
  });

  it("does not count the same stated capability twice", () => {
    const { verified, rejected } = verifyStated(
      [
        {
          text: "Remind the supervisor of old notes",
          quote: "send the supervisor a reminder when a note is more than two hours old",
        },
        {
          text: "Supervisor reminder for old notes",
          quote: "supervisor a reminder when a note is more than two hours old",
        },
      ],
      owner,
    );
    expect(verified).toHaveLength(1);
    expect(rejected[0]?.reason).toMatch(/duplicate/);
  });
});

const caps: StatedCapability[] = [
  {
    key: "c1",
    text: "Type a note once for both systems",
    quote: "type every note twice, once in the patient system and once in a spreadsheet",
  },
  {
    key: "c2",
    text: "Print handover list sorted by bed",
    quote: "handover list printed for the night shift, sorted by bed number",
  },
  {
    key: "c3",
    text: "Remind the supervisor about old notes",
    quote: "send the supervisor a reminder when a note is more than two hours old",
  },
];

describe("deterministic coverage", () => {
  const reqs = [
    req("FR-1", "Nurse types a note once and it reaches both the patient system and the spreadsheet"),
    req("FR-2", "Print the handover list sorted by bed number for the night shift"),
    req("FR-3", "Export a weekly audit report"),
  ];

  it("covers by words and leaves unrelated ones uncovered", () => {
    const m = matchCapabilities(caps, reqs);
    expect(m[0]).toMatchObject({ decision: "yes", by: "FR-1" });
    expect(m[1]).toMatchObject({ decision: "yes", by: "FR-2" });
    expect(m[2]?.decision).toBe("no");
  });

  it("covers through a requirement's own evidence quote", () => {
    const m = matchCapabilities(
      [caps[2]!],
      [
        req("FR-9", "Overdue note nudges", {
          evidence: "send the supervisor a reminder when a note is more than two hours old",
        }),
      ],
    );
    expect(m[0]).toMatchObject({ decision: "yes", by: "FR-9", viaEvidence: true });
  });

  it("evidenceMatches needs several shared words", () => {
    expect(evidenceMatches("a reminder", "a reminder")).toBe(false);
    expect(
      evidenceMatches(
        "send the supervisor a reminder when a note is old",
        "the supervisor a reminder when a note is old",
      ),
    ).toBe(true);
  });
});

describe("settling the middle with a model's answers", () => {
  const reqs = [req("FR-1", "Supervisor alerts on old notes"), req("FR-2", "Handover")];
  const cap: StatedCapability = {
    key: "c1",
    text: "Remind supervisor when a note is old",
    quote: "reminder when a note is more than two hours old",
  };
  const m = matchCapabilities([cap], reqs);

  it("is unsure and takes the model's candidate", () => {
    expect(m[0]?.decision).toBe("unsure");
    const s = settleMatches(m, { c1: "FR-1" }, new Set(["FR-1", "FR-2"]));
    expect(s[0]).toMatchObject({ covered: true, by: "FR-1", how: "model" });
  });

  it("refuses an id the code did not offer, an unknown one and a null", () => {
    expect(settleMatches(m, { c1: "FR-77" }, new Set(["FR-1"]))[0]?.covered).toBe(false);
    expect(settleMatches(m, { c1: "FR-2" }, new Set(["FR-1", "FR-2"]))[0]?.covered).toBe(false);
    expect(settleMatches(m, { c1: null }, new Set(["FR-1"]))[0]?.covered).toBe(false);
  });
});

describe("precision", () => {
  it("supports a requirement by verified evidence or by a matched capability", () => {
    const rows = precisionRows(
      [
        req("FR-1", "a", { evidence: "Nurses type every note twice" }),
        req("FR-2", "b", { evidence: "something the owner never said at all" }),
        req("FR-3", "c"),
      ],
      ["FR-3", null],
      owner,
    );
    expect(rows.map((r) => r.supported)).toEqual([true, false, true]);
    expect(rows[0]?.evidenceVerified).toBe(true);
    expect(rows[2]?.matched).toBe(true);
  });
});

describe("intervals", () => {
  it("wilson is honest at small n", () => {
    const w = wilson(3, 4);
    expect(w.rate).toBe(0.75);
    expect(w.low).toBeCloseTo(0.301, 2);
    expect(w.high).toBeCloseTo(0.954, 2);
    expect(wilson(0, 0).rate).toBeNull();
    expect(wilson(10, 10).high).toBe(1);
  });

  it("bootstrap is reproducible, ordered, and null for one interview", () => {
    const c = [
      { k: 4, n: 10 },
      { k: 8, n: 10 },
      { k: 6, n: 12 },
    ];
    expect(clusterBootstrap(c)).toEqual(clusterBootstrap(c));
    const b = clusterBootstrap(c);
    expect(b.low).toBeLessThan(b.high ?? 0);
    expect(clusterBootstrap([{ k: 1, n: 2 }])).toEqual({ low: null, high: null });
    expect(mulberry32(1)()).toBeGreaterThanOrEqual(0);
  });

  it("pools per persona and overall", () => {
    const s = summarize([
      { spec: "a", persona: "nt", capabilities: 10, covered: 6, requirements: 8, supported: 6 },
      { spec: "b", persona: "nt", capabilities: 10, covered: 8, requirements: 10, supported: 9 },
      { spec: "c", persona: "t", capabilities: 5, covered: 5, requirements: 5, supported: 5 },
    ]);
    expect(s.map((x) => x.persona)).toEqual(["nt", "t", "all"]);
    expect(s[0]?.recall.rate).toBe(0.7);
    expect(s[0]?.perInterviewRecall).toEqual([0.6, 0.8]);
    expect(s[2]?.recall.k).toBe(19);
  });
});

describe("attributing loss to a stage", () => {
  it("separates never recorded from lost after capture", () => {
    const r = attributeLoss(new Set(["c1", "c2"]), new Set(["c1", "c4"]), ["c1", "c2", "c3", "c4"]);
    expect(r).toEqual({ neverRecorded: ["c3"], lostAfterCapture: ["c2"], gainedAfterCapture: ["c4"] });
  });
});

describe("what merging dropped (D-301)", () => {
  const titles = new Map([
    ["FR-2", "Nurse opens the note history from a View History button"],
    ["FR-3", "Nurse enters a note once"],
  ]);
  it("reports a merged title whose words did not reach the survivor", () => {
    const m = mergedAway(
      [
        {
          id: "FR-1",
          title: "Nurse enters a note once for both systems",
          acceptance: [],
          mergedFrom: ["FR-2", "FR-3"],
        },
      ],
      titles,
    );
    expect(m.find((x) => x.id === "FR-3")?.kept).toBe(1);
    expect(m.find((x) => x.id === "FR-2")?.kept).toBeLessThan(0.5);
    expect(lostTitles(m).map((x) => x.id)).toEqual(["FR-2"]);
  });

  it("counts a title kept as an acceptance criterion as kept", () => {
    const m = mergedAway(
      [
        {
          id: "FR-1",
          title: "Nurse enters a note once",
          acceptance: ["Nurse opens the note history from a View History button"],
          mergedFrom: ["FR-2"],
        },
      ],
      titles,
    );
    expect(lostTitles(m)).toEqual([]);
  });
});
