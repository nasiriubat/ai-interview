import type { StatsAi, StatsHealth, StatsParticipation, StatsRequirements } from "@aidp/shared";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  HealthPanel,
  LatencyPanel,
  ParticipationPanel,
  RequirementsPanel,
} from "@/components/admin/DashboardStats";
import { DiscoveryTiles } from "@/components/admin/DiscoveryTiles";

/*
 * The dashboard statistics (spec 07) as the page renders them: translated labels, and a figure the
 * API withheld for being derived from fewer than k people says so instead of showing a dash.
 */

const participation = (over: Partial<StatsParticipation> = {}): StatsParticipation => ({
  k: 3,
  campaigns: { open: 1, total: 2 },
  funnel: { invited: 10, opened: 8, started: 6, completed: 4 },
  medianActiveSeconds: 1500,
  medianSessions: 4,
  identified: { identified: 3, anonymous: 3, share: 0.5 },
  reminders: { sent: 7, invitationsReminded: 5 },
  dropOff: {
    areas: [{ areaKey: "tasks", name: "Daily tasks", sessions: 3 }],
    other: 2,
    unfinished: 5,
  },
  ...over,
});

describe("participation", () => {
  it("shows the median length, the identified share and the reminders", () => {
    render(<ParticipationPanel segment={{ data: participation(), error: null }} />);
    expect(screen.getByText("25 min")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("3 identified, 3 anonymous")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    const drop = screen.getByRole("list", { name: "Where interviews stopped" });
    expect(within(drop).getByText("Daily tasks")).toBeInTheDocument();
    // The areas with too few interviews are pooled, not named.
    expect(within(drop).getByText("Areas with few interviews")).toBeInTheDocument();
  });

  it("says a figure is withheld when too few interviews are behind it", () => {
    render(
      <ParticipationPanel
        segment={{
          data: participation({
            medianActiveSeconds: null,
            medianSessions: 2,
            identified: { identified: null, anonymous: null, share: null, withheld: "below_k" },
          }),
          error: null,
        }}
      />,
    );
    expect(screen.getAllByText("Fewer than 3 interviews, so this is not shown.")).toHaveLength(2);
  });

  it("keeps the panel's own error state when the segment failed", () => {
    render(<ParticipationPanel segment={{ data: null, error: new Error("down") }} />);
    expect(screen.getByText("Statistics are unavailable right now.")).toBeInTheDocument();
  });
});

describe("requirements", () => {
  const base: StatsRequirements = {
    projectsByStatus: { completed: 3, active: 1 },
    turnsToSpec: { median: 15, mean: 15, sessions: 2 },
    findings: { raised: 4, resolved: 2, resolvedRatio: 0.5, byType: { ambiguity: 4 } },
    specVersions: 2,
  };

  it("shows turns to a specification and the share of findings settled", () => {
    render(<RequirementsPanel segment={{ data: base, error: null }} />);
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText("2 of 4 settled")).toBeInTheDocument();
    expect(screen.getByText("Median over 2 finished projects")).toBeInTheDocument();
  });

  it("says so when there are no projects", () => {
    render(<RequirementsPanel segment={{ data: { ...base, projectsByStatus: {} }, error: null }} />);
    expect(screen.getByText("No requirements projects yet.")).toBeInTheDocument();
  });
});

describe("response times", () => {
  const ai: StatsAi = {
    window: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    calls: 25,
    latency: [{ purpose: "interview_turn", calls: 20, fullMs: { p50: 1050, p95: 1905 }, firstTokenMs: null }],
    outcomes: { ok: 20, error: 2, refused: 1, budgetExceeded: 1, aborted: 1 },
    errorRate: 0.08,
    refusalRate: 0.04,
    failureRate: 0.16,
    cacheHitRate: null,
    tokensPerInterview: 500,
    interviews: 6,
  };

  it("names the task, gives the median and the 95th percentile, and is honest about the first word", () => {
    render(<LatencyPanel segment={{ data: ai, error: null }} />);
    const row = screen.getByRole("row", { name: /Interview questions/ });
    expect(within(row).getByText("1.1 s")).toBeInTheDocument();
    expect(within(row).getByText("1.9 s")).toBeInTheDocument();
    expect(within(row).getByText("Not recorded yet")).toBeInTheDocument();
    expect(screen.getByText("16%")).toBeInTheDocument();
  });
});

describe("health", () => {
  it("shows queue depth, failures and storage against the quota", () => {
    const h: StatsHealth = {
      queues: [],
      depth: { queued: 3, active: 1 },
      failedJobs: 2,
      storage: { bytes: 5 * 1024 * 1024, files: 4, byKind: {}, quotaBytes: 5120 * 1024 * 1024 },
    };
    render(<HealthPanel segment={{ data: h, error: null }} />);
    expect(screen.getByText("Waiting jobs")).toBeInTheDocument();
    expect(screen.getByText("5 MB")).toBeInTheDocument();
    expect(screen.getByText("5 MB of 5 GB · 4 files")).toBeInTheDocument();
  });
});

describe("discovery tiles", () => {
  it("count where AI is not the answer with the report's predicate, under translated class names", () => {
    render(
      <DiscoveryTiles
        discovery={{
          byClass: { ai: 2, automation: 1, software: 0, process: 3, none: 1 },
          top: null,
        }}
      />,
    );
    const tile = screen.getByText("Where AI is not the answer").closest("[data-slot=card]")!;
    expect(within(tile as HTMLElement).getByText("4")).toBeInTheDocument();
    expect(screen.getByText("Leave as is")).toBeInTheDocument();
  });
});
