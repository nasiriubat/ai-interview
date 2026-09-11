import { SessionStateSchema, type DetectedFinding, type Finding } from "@aidp/shared";
import { describe, expect, it } from "vitest";
import { ShippedPromptSource } from "../../src/engine/prompts/index.js";
import { detectIssues, selectFindings, shouldScanIssues } from "../../src/spec/issues.js";
import { resolvePolicy, type RequirementsPolicy } from "../../src/spec/policy.js";
import { ScriptedCaller, template } from "../engine/helpers.js";

const det = (
  type: DetectedFinding["type"],
  section: string,
  confidence: DetectedFinding["confidence"] = "medium",
  path?: string,
): DetectedFinding => ({
  type,
  section,
  ...(path ? { path } : {}),
  description: `${type} in ${section}${path ? `/${path}` : ""}`,
  resolution: "decide",
  default: "default",
  confidence,
});

const policy = (over: Partial<RequirementsPolicy> = {}): RequirementsPolicy => ({
  enabled: true,
  everyTurns: 5,
  aggressiveness: "standard",
  typesEnabled: ["ambiguity", "contradiction", "missing_decision", "over_complexity"],
  pushBackOnce: true,
  mvpChallenge: "optional",
  ...over,
});

const reqTemplate = template({
  outputs: ["spec_field"],
  issueDetection: { enabled: true, everyTurns: 5, aggressiveness: "standard", mvpChallenge: true },
});

describe("selectFindings", () => {
  const detected = [
    det("over_complexity", "functional", "high", "FR-2"),
    det("ambiguity", "nfr", "high"),
    det("contradiction", "technical", "medium", "hosting"),
    det("missing_decision", "security", "low"),
  ];

  it("standard: one per pass, highest confidence first, then contradictions before ambiguities", () => {
    const picked = selectFindings(detected, [], policy(), "technical", 7);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({
      id: "f7-1",
      type: "ambiguity",
      section: "nfr",
      status: "open",
      pushedBack: false,
    });
  });

  it("gentle: contradictions and missing decisions only", () => {
    const picked = selectFindings(detected, [], policy({ aggressiveness: "gentle" }), "technical", 1);
    expect(picked.map((f) => f.type)).toEqual(["contradiction"]);
  });

  it("strict: up to three per pass", () => {
    const picked = selectFindings(detected, [], policy({ aggressiveness: "strict" }), "technical", 1);
    expect(picked).toHaveLength(3);
  });

  it("nontechnical path: technical sections are held to the gentle rule, the rest to standard", () => {
    const picked = selectFindings(
      [det("ambiguity", "nfr", "high"), det("ambiguity", "stories", "medium")],
      [],
      policy(),
      "nontechnical",
      1,
    );
    expect(picked.map((f) => f.section)).toEqual(["stories"]);
  });

  it("drops disabled types and anything already in state, by location or by wording", () => {
    const existing: Finding[] = [
      { ...det("ambiguity", "nfr"), id: "f1", status: "accepted", pushedBack: false, confidence: "high" },
    ];
    const picked = selectFindings(
      [
        det("ambiguity", "nfr", "high"),
        det("over_complexity", "functional", "high", "FR-2"),
        { ...det("contradiction", "data"), description: "ambiguity in nfr" },
      ],
      existing,
      policy({ typesEnabled: ["ambiguity", "contradiction"] }),
      "technical",
      2,
    );
    expect(picked).toHaveLength(0);
  });
});

describe("shouldScanIssues and resolvePolicy", () => {
  const facts = [
    { kind: "spec_field" as const, section: "overview", path: "p", value: "v", source: "user" as const },
  ];

  it("scans every N turns once spec fields exist and the context block is done, and once more at completion", () => {
    const p = resolvePolicy(reqTemplate, "technical");
    expect(p).toMatchObject({
      enabled: true,
      everyTurns: 5,
      aggressiveness: "standard",
      mvpChallenge: "optional",
    });
    const st = (over: object) => SessionStateSchema.parse({ facts, ...over });
    expect(shouldScanIssues(reqTemplate, st({ turnCount: 4 }), p)).toBeUndefined();
    expect(shouldScanIssues(reqTemplate, st({ turnCount: 5 }), p)).toBe("periodic");
    expect(shouldScanIssues(reqTemplate, st({ turnCount: 5, lastIssueScanTurn: 3 }), p)).toBeUndefined();
    expect(
      shouldScanIssues(
        reqTemplate,
        st({
          turnCount: 1,
          coverage: {
            role: { status: "covered" },
            daily: { status: "covered" },
            problems: { status: "covered" },
          },
        }),
        p,
      ),
    ).toBe("final");
    expect(
      shouldScanIssues(
        reqTemplate,
        st({
          turnCount: 1,
          finalIssueScanDone: true,
          coverage: {
            role: { status: "covered" },
            daily: { status: "covered" },
            problems: { status: "covered" },
          },
        }),
        p,
      ),
    ).toBeUndefined();
    expect(shouldScanIssues(reqTemplate, SessionStateSchema.parse({ turnCount: 5 }), p)).toBeUndefined();
    expect(
      shouldScanIssues(
        reqTemplate,
        st({
          turnCount: 5,
          findings: [
            {
              id: "f",
              type: "ambiguity",
              section: "x",
              description: "d",
              resolution: "r",
              default: "d",
              status: "raised",
            },
          ],
        }),
        p,
      ),
    ).toBeUndefined();
  });

  it("is off for templates that do not produce a spec, and settings override the template per path", () => {
    expect(resolvePolicy(template(), undefined).enabled).toBe(false);
    expect(resolvePolicy(template(), undefined).mvpChallenge).toBe("off");
    const p = resolvePolicy(reqTemplate, "nontechnical", {
      aggressivenessTechnical: "strict",
      aggressivenessNontechnical: "gentle",
      mvpChallenge: "mandatory",
    });
    expect(p.aggressiveness).toBe("gentle");
    expect(p.mvpChallenge).toBe("mandatory");
    expect(
      resolvePolicy(reqTemplate, "technical", {
        aggressivenessTechnical: "strict",
        aggressivenessNontechnical: "template",
        mvpChallenge: "template",
      }).aggressiveness,
    ).toBe("strict");
  });
});

describe("detectIssues", () => {
  const logger = { warn: () => undefined, info: () => undefined };
  const state = SessionStateSchema.parse({
    turnCount: 5,
    facts: [
      { kind: "spec_field", section: "functional", path: "FR-1", value: { title: "Login" }, source: "user" },
    ],
  });

  it("calls the issue_detection purpose with the spec state and returns filtered findings", async () => {
    const caller = new ScriptedCaller([
      JSON.stringify({
        findings: [
          {
            type: "missing_decision",
            section: "security",
            description: "No sign-in method",
            resolution: "Choose one",
            default: "magic link",
            confidence: "high",
          },
          {
            type: "ambiguity",
            section: "functional",
            path: "FR-1",
            description: "Login is vague",
            resolution: "Define",
            default: "email",
            confidence: "low",
          },
        ],
      }),
    ]);
    const found = await detectIssues(
      { caller: caller.asCaller(), prompts: new ShippedPromptSource(), logger },
      {
        companyId: "c",
        sessionId: "s",
        template: reqTemplate,
        state,
        path: "technical",
        policy: policy(),
        reason: "periodic",
      },
    );
    expect(caller.requests[0]?.purpose).toBe("issue_detection");
    expect(String(caller.requests[0]?.req.messages[0]?.content)).toContain("FR-1");
    expect(String(caller.requests[0]?.req.system)).toContain(
      "ambiguity, contradiction, missing_decision, over_complexity",
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: "f5-1",
      type: "missing_decision",
      section: "security",
      status: "open",
    });
  });

  it("never fails the turn: a broken model answer yields no findings and a warning", async () => {
    const warnings: string[] = [];
    const caller = new ScriptedCaller(["not json"]);
    const found = await detectIssues(
      {
        caller: caller.asCaller(),
        prompts: new ShippedPromptSource(),
        logger: { warn: (m) => warnings.push(m), info: () => undefined },
      },
      { companyId: "c", sessionId: "s", template: reqTemplate, state, policy: policy(), reason: "final" },
    );
    expect(found).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});
