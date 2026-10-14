import { describe, expect, it } from "vitest";
import {
  GitHubPushResultSchema,
  InviteArrivalSchema,
  LiveSpecSchema,
  RequirementsDetailSchema,
  RequirementsPageSchema,
  RequirementsSessionEnvelopeSchema,
  SessionInvitationEnvelopeSchema,
  SpecDiffSchema,
  SpecVersionDetailSchema,
  SpecVersionEnvelopeSchema,
  SpecVersionListSchema,
} from "@/lib/api/schemas";

const liveSpec = {
  title: "Clinic booking",
  path: "nontechnical",
  context: { users: "Front desk", volume: "200 bookings a day" },
  sections: [
    {
      key: "overview",
      title: "Product overview and problem",
      status: "draft",
      markdown: "Bookings by phone are slow.",
      fields: [{ path: "problem", value: "slow", source: "user" }],
    },
    {
      key: "diagrams",
      title: "Diagrams",
      status: "edited",
      markdown: "```mermaid\ngraph LR\nA-->B\n```",
      fields: [],
    },
  ],
  findings: [
    {
      id: "f1",
      type: "missing_decision",
      section: "security",
      path: "auth",
      description: "How do staff sign in?",
      resolution: "Pick SSO or email",
      default: "Email and password",
      confidence: "high",
      status: "raised",
      pushedBack: false,
      raisedTurn: 6,
    },
  ],
  decisions: [{ key: "auth", question: "Sign-in?", choice: "SSO", source: "user" }],
  mvpChallenge: { started: true, done: false, asked: ["FR-3"] },
  stats: { fields: 12, sectionsWithContent: 5, openFindings: 1 },
};

describe("contract 18 schemas", () => {
  it("parses the requirements list and the session envelope", () => {
    const page = RequirementsPageSchema.parse({
      sessions: [
        {
          id: "s1",
          title: "Clinic booking",
          status: "active",
          path: "technical",
          sourceKind: "text",
          ownerUserId: "u1",
          ownerEmail: "owner@example.com",
          versions: 2,
          openFindings: 1,
          createdAt: "2026-09-01T10:00:00Z",
        },
      ],
    });
    expect(page.items[0]).toMatchObject({ id: "s1", versions: 2, openFindings: 1, path: "technical" });

    const session = RequirementsSessionEnvelopeSchema.parse({
      session: {
        id: "s1",
        title: "Clinic booking",
        status: "created",
        path: "technical",
        sourceKind: "text",
        ownerUserId: "u1",
        handoff: null,
        templateId: "t1",
        language: "en",
        progress: { areas: [{ key: "problem", name: "Problem", status: "untouched" }] },
        phase: "context",
        createdAt: "2026-09-01T10:00:00Z",
      },
    });
    expect(session.progress.areas[0]?.status).toBe("untouched");
    expect(session.handoff).toBeNull();
  });

  it("parses the workspace detail with the live spec, versions and invitations", () => {
    const detail = RequirementsDetailSchema.parse({
      session: { id: "s1", title: "Clinic booking", status: "active", path: "nontechnical", language: "fi" },
      messages: [{ id: "m1", seq: 1, role: "assistant", content: "Hi", createdAt: "" }],
      spec: liveSpec,
      versions: [
        {
          id: "v1",
          version: 1,
          label: "first",
          status: "done",
          createdAt: "2026-09-02T10:00:00Z",
          finishedAt: "2026-09-02T10:01:00Z",
          stats: {
            sections: 16,
            requirements: 8,
            mvp: 5,
            future: 3,
            phases: 2,
            openFindings: 0,
            promptVersions: ["spec-1"],
          },
        },
      ],
      invitations: [
        {
          id: "i1",
          email: "client@example.com",
          status: "sent",
          sentAt: "2026-09-02T10:00:00Z",
          expiresAt: "2026-09-09T10:00:00Z",
        },
      ],
    });
    expect(detail.spec.sections).toHaveLength(2);
    expect(detail.spec.findings[0]?.status).toBe("raised");
    expect(detail.versions[0]?.stats.requirements).toBe(8);
    expect(detail.invitations[0]?.status).toBe("sent");
  });

  it("fills live spec defaults for a thin answer", () => {
    const spec = LiveSpecSchema.parse({
      title: "x",
      path: null,
      context: {},
      sections: [],
      findings: [],
      decisions: [],
    });
    expect(spec.mvpChallenge).toEqual({ started: false, done: false, asked: [], outcome: "pending" });
    expect(spec.stats.openFindings).toBe(0);
  });

  it("parses version summaries, detail, diff and the GitHub result", () => {
    const queued = SpecVersionEnvelopeSchema.parse({
      version: { id: "v2", version: 2, status: "queued", createdAt: "" },
    });
    expect(queued.stats).toMatchObject({ sections: 0, requirements: 0, promptVersions: [] });

    const list = SpecVersionListSchema.parse({
      versions: [{ id: "v2", version: 2, status: "running", createdAt: "" }],
    });
    expect(list[0]?.status).toBe("running");

    const detail = SpecVersionDetailSchema.parse({
      version: { id: "v1", version: 1, status: "done", createdAt: "", stats: { sections: 3 } },
      document: {
        title: "Clinic booking",
        language: "en",
        path: "technical",
        generatedAt: "2026-09-02T10:01:00Z",
        context: {},
        sections: [{ key: "overview", title: "Overview", markdown: "Text", source: "generated" }],
        requirements: [{ id: "FR-1", title: "Book a slot", scope: "mvp", acceptance: ["A slot is booked"] }],
        phases: [
          {
            key: "p1",
            name: "Phase 1",
            goals: [],
            tasks: [{ title: "Build", acceptance: [] }],
            dependencies: [],
            acceptance: [],
          },
        ],
        openQuestions: [{ question: "SMS?", defaultTaken: "No" }],
        mvp: { in: ["FR-1"], movedOut: [], next: [] },
        diagrams: [{ key: "ctx", title: "Context", type: "context", mermaid: "graph LR\nA-->B" }],
      },
      markdown: "# Clinic booking",
      bundle: {
        format: "claude_code",
        files: [
          { path: "AGENTS.md", content: "# Agents" },
          { path: "spec.md", content: "# Clinic booking" },
        ],
      },
      issues: [],
    });
    expect(detail.document?.requirements[0]?.scope).toBe("mvp");
    expect(detail.bundle?.files.map((f) => f.path)).toEqual(["AGENTS.md", "spec.md"]);

    const pending = SpecVersionDetailSchema.parse({
      version: { id: "v2", version: 2, status: "queued", createdAt: "" },
    });
    expect(pending.document).toBeUndefined();
    expect(pending.markdown).toBe("");

    const diff = SpecDiffSchema.parse({
      sections: [
        {
          key: "overview",
          title: "Overview",
          change: "changed",
          lines: [
            { type: "same", text: "a" },
            { type: "del", text: "b" },
            { type: "add", text: "c" },
          ],
        },
      ],
      requirements: { added: [{ id: "FR-2", title: "Cancel" }], removed: [], changed: [] },
    });
    expect(diff.sections[0]?.lines).toHaveLength(3);
    expect(diff.requirements.added[0]).toMatchObject({ id: "FR-2", scope: "mvp" });

    expect(
      GitHubPushResultSchema.parse({ commitUrl: "https://github.com/o/r/commit/abc", files: 6 }).files,
    ).toBe(6);
    expect(
      SessionInvitationEnvelopeSchema.parse({
        invitation: { id: "i1", email: "a@b.c", status: "sent", sentAt: "", expiresAt: "" },
      }).id,
    ).toBe("i1");
  });

  it("parses the public invite arrival", () => {
    const info = InviteArrivalSchema.parse({
      session: {
        title: "Clinic booking",
        productName: "Discovery",
        purpose: "Specify the booking flow",
        consentText: "We store your answers.",
        consentVersion: "v3",
        pathSelection: "technical_or_not",
        language: "fi",
      },
      status: "open",
    });
    expect(info.status).toBe("open");
    expect(info.session.pathSelection).toBe("technical_or_not");
    expect(() => InviteArrivalSchema.parse({ session: {}, status: "closed" })).toThrow();
  });
});
