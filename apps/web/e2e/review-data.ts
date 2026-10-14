/*
 * Richer answers for the analysis, configuration and operator pages (D-370), selected by the fake
 * API's scenario (`POST /__scenario`). They exist so a design review can see a populated results
 * page, a withheld department, a stale run, an empty tenant and an error without a database. The
 * accessibility pass runs the `default` scenario, which is the populated one.
 *
 * Nothing here is a contract: shapes follow `src/lib/api/schemas.ts`, and every value is invented.
 */

const NOW = "2026-10-14T09:30:00.000Z";
const EARLIER = "2026-10-10T08:00:00.000Z";

type Out = { status?: number; body: unknown } | undefined;

const FACTORS = [
  "expected_impact",
  "affected_employees",
  "frequency",
  "implementation_complexity",
  "data_availability",
  "risk",
  "ai_suitability",
] as const;

function factors(scores: number[]): Record<string, { score: number; rationale: string }> {
  return Object.fromEntries(
    FACTORS.map((k, i) => [
      k,
      {
        score: scores[i] ?? 3,
        rationale:
          (scores[i] ?? 3) >= 4
            ? "Named by most of the people who described this work, with concrete examples."
            : "Mentioned by a few people; the effect varies between teams.",
      },
    ]),
  );
}

interface Seed {
  id: string;
  title: string;
  cls: string;
  scores: number[];
  participants: number;
  minutes: number;
  roles: string[];
  departments: string[];
  tools: string[];
  quotes: string[];
  whyNotAi?: string;
  status?: string;
  summary: string;
}

const SEEDS: Seed[] = [
  {
    id: "op1",
    title: "Handover summaries drafted from the shift notes",
    cls: "ai",
    scores: [5, 5, 5, 3, 4, 3, 5],
    participants: 9,
    minutes: 540,
    roles: ["Registered nurse", "Charge nurse"],
    departments: ["Nursing", "Ward 4"],
    tools: ["Patient record", "Paper notebook"],
    summary: "Nurses rewrite the same observations into a handover note at the end of every shift.",
    quotes: [
      "I spend the last forty minutes of every shift writing down what I already wrote in the record.",
      "The night team reads my note and then asks me the same three things anyway.",
      "If the summary were there when I sat down I would only have to check it.",
    ],
  },
  {
    id: "op2",
    title: "Automatic reminder messages for appointments that were rescheduled at short notice",
    cls: "automation",
    scores: [4, 4, 5, 2, 5, 2, 3],
    participants: 7,
    minutes: 420,
    roles: ["Receptionist"],
    departments: ["Front desk and patient registration"],
    tools: ["Phone", "Booking system"],
    summary: "Reception calls patients one by one when a clinic changes its hours.",
    quotes: [
      "When a doctor falls ill I phone thirty people. It takes the whole morning.",
      "Half of them do not pick up, so I ring again after lunch.",
    ],
  },
  {
    id: "op3",
    title: "Single entry of observations across the ward chart and the doctors' system",
    cls: "software",
    scores: [4, 4, 4, 4, 3, 2, 2],
    participants: 8,
    minutes: 360,
    roles: ["Registered nurse", "Doctor"],
    departments: ["Nursing", "Internal medicine"],
    tools: ["Ward chart", "Doctors' system"],
    summary: "The same values are typed into two systems that do not share a record.",
    quotes: ["We type everything twice. Once for us and once for them."],
  },
  {
    id: "op4",
    title: "Triage of incoming referral letters",
    cls: "ai",
    scores: [4, 3, 4, 3, 3, 4, 4],
    participants: 5,
    minutes: 300,
    roles: ["Secretary", "Doctor"],
    departments: ["Outpatient clinic"],
    tools: ["Fax", "E-mail"],
    summary: "Referrals arrive in free text and are sorted by hand before a doctor sees them.",
    quotes: [
      "Most letters are routine. The two that are not are buried somewhere in the pile.",
      "I read every one in full because I am afraid to miss the urgent one.",
    ],
  },
  {
    id: "op5",
    title: "Discharge letter drafting",
    cls: "ai",
    scores: [3, 3, 3, 3, 4, 4, 4],
    participants: 4,
    minutes: 210,
    roles: ["Doctor"],
    departments: ["Internal medicine"],
    tools: ["Word processor"],
    summary: "Letters are written from scratch although most of the content is in the record.",
    quotes: ["I could dictate it, but then someone still has to format it."],
  },
  {
    id: "op6",
    title: "Supply order forecasting for ward stock",
    cls: "automation",
    scores: [3, 2, 4, 3, 3, 2, 3],
    participants: 3,
    minutes: 150,
    roles: ["Ward assistant"],
    departments: ["Ward 4"],
    tools: ["Spreadsheet"],
    summary: "Stock is counted on paper and ordered when the shelf looks empty.",
    quotes: ["We run out of gloves on the one day the delivery is late."],
  },
  {
    id: "op7",
    title: "Night shift rota posted to a shared calendar",
    cls: "process",
    scores: [2, 3, 3, 1, 4, 1, 1],
    participants: 6,
    minutes: 90,
    roles: ["Charge nurse"],
    departments: ["Nursing"],
    tools: ["Paper rota"],
    whyNotAi:
      "A staffing decision that people want to make together. A shared calendar solves it without a model.",
    summary: "Swaps are agreed in the corridor and lost.",
    quotes: ["Nobody knows who is on until they see the board."],
  },
  {
    id: "op8",
    title: "Keep the paper allergy wristbands",
    cls: "none",
    scores: [1, 3, 2, 1, 1, 5, 1],
    participants: 3,
    minutes: 20,
    roles: ["Registered nurse"],
    departments: ["Nursing"],
    tools: ["Wristband"],
    whyNotAi: "It works, it is visible at a glance, and a failure here is a safety risk. Leave it as it is.",
    summary: "People asked whether wristbands could go digital.",
    quotes: [],
  },
  {
    id: "op9",
    title: "Shift swap requests",
    cls: "process",
    scores: [2, 3, 3, 2, 3, 2, 2],
    participants: 4,
    minutes: 60,
    roles: ["Registered nurse"],
    departments: ["Nursing"],
    tools: ["Group chat"],
    whyNotAi: "The rules for approving a swap are not written down; write them first.",
    summary: "Requests arrive in a group chat and are answered by whoever sees them.",
    quotes: ["I never know whether my swap was approved."],
  },
];

function opportunity(
  s: Seed,
  analysisId: string,
  longTitles: boolean,
  withhold: boolean,
): Record<string, unknown> {
  const f = factors(s.scores);
  const weighted = Object.values(f).reduce((a, v) => a + v.score, 0);
  const title = longTitles
    ? `${s.title}, including the cases where the patient has moved between wards during the same week and the note has to follow them`
    : s.title;
  return {
    id: s.id,
    analysisId,
    clusterKey: `c-${s.id}`,
    title,
    summary: s.summary,
    solutionClass: s.cls,
    rankScore: Math.round((weighted / 35) * 100),
    status: s.status ?? "new",
    factors: f,
    rationale: "Frequent, concrete, and the source data is already structured.",
    adminOverride: null,
    evidence: withhold
      ? []
      : s.quotes.map((q, i) => ({ factId: `${s.id}-f${String(i)}`, snippet: q, anonymized: true })),
    stats: {
      participants: s.participants,
      facts: s.participants * 3,
      roles: s.roles,
      departments: s.departments,
      tools: s.tools,
      minutesPerWeekTotal: s.minutes,
      quotes: withhold ? [] : s.quotes,
    },
    dataNeeded: ["Observation records", "Shift calendar"],
    risks: ["Patient data leaves the ward system", "Wrong summary acted on without a check"],
    whyNotAi: s.whyNotAi ?? null,
    createdAt: NOW,
  };
}

const analysisOf = (
  id: string,
  version: number,
  status: string,
  extra: Record<string, unknown> = {},
  stats: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  campaignId: "camp1",
  version,
  status,
  preliminary: false,
  stats: {
    sessions: 11,
    facts: 142,
    clusters: 9,
    participants: 11,
    thresholdMet: true,
    embedding: "provider",
    trigger: "manual",
    ...stats,
  },
  startedAt: EARLIER,
  finishedAt: status === "done" || status === "failed" ? NOW : null,
  createdAt: EARLIER,
  ...extra,
});

const REPORT = `# Ward round, Q4: what to improve first

## Executive summary

Eleven people described how their work runs. Three opportunities stand out: handover notes, reminder
messages for rescheduled appointments, and entering observations twice.

## Participation

Eleven of fourteen invited people finished an interview. Departments with fewer than three people are
not shown.

## Opportunities

| Rank | Opportunity | Class | Score |
| --- | --- | --- | --- |
| 1 | Handover summaries drafted from the shift notes | AI | 86 |
| 2 | Automatic reminder messages | Automation | 77 |
| 3 | Single entry of observations | Software | 71 |

> "I spend the last forty minutes of every shift writing down what I already wrote in the record."

## Where AI is not the answer

The night shift rota and the paper allergy wristbands are better left to people.

## Next steps

Start with handover summaries; run a requirements interview with the charge nurses.
`;

function analyses(name: string): Record<string, unknown>[] {
  switch (name) {
    case "empty":
      return [];
    case "running":
      return [
        analysisOf("an3", 3, "running", { finishedAt: null }, { trigger: "auto" }),
        analysisOf("an2", 2, "done"),
        analysisOf("an1", 1, "done", {}, { sessions: 6, facts: 71, clusters: 5, participants: 6 }),
      ];
    case "autoqueued":
      return [
        analysisOf(
          "an1",
          1,
          "queued",
          { finishedAt: null },
          { trigger: "auto", autoStartAt: "2026-10-14T09:45:00.000Z" },
        ),
      ];
    case "failed":
      return [
        analysisOf("an2", 2, "failed", {}, { error: "The model provider answered 429 for three attempts." }),
        analysisOf("an1", 1, "done"),
      ];
    case "preliminary":
      return [
        analysisOf(
          "an1",
          1,
          "done",
          { preliminary: true },
          { thresholdMet: false, sessions: 2, participants: 2 },
        ),
      ];
    default:
      return [
        analysisOf("an2", 2, "done", {}, { trigger: "auto" }),
        analysisOf("an1", 1, "done", {}, { sessions: 6, facts: 71, clusters: 5, participants: 6 }),
      ];
  }
}

const DEPARTMENTS = {
  shown: true,
  k: 3,
  belowK: 2,
  departments: [
    {
      name: "Front desk and patient registration",
      kind: "department",
      participants: 4,
      facts: 18,
      minutesPerWeek: 1260,
      topOpportunities: [
        {
          clusterKey: "c-op2",
          title: "Automatic reminder messages for appointments that were rescheduled at short notice",
          share: 0.75,
        },
        { clusterKey: "c-op3", title: "Single entry of visitor details at the reception desk", share: 0.5 },
      ],
      solutionClassShare: { ai: 0.1, automation: 0.6, software: 0.2, process: 0.1 },
    },
    {
      name: "Nursing",
      kind: "department",
      participants: 5,
      facts: 41,
      minutesPerWeek: 2340,
      topOpportunities: [
        { clusterKey: "c-op1", title: "Handover summaries drafted from the shift notes", share: 0.8 },
      ],
      solutionClassShare: { ai: 0.45, software: 0.25, process: 0.2, automation: 0.1 },
    },
    {
      name: "Outpatient clinic",
      kind: "department",
      participants: 3,
      facts: 12,
      minutesPerWeek: 540,
      topOpportunities: [],
      solutionClassShare: { ai: 0.67 },
    },
    {
      name: null,
      kind: "other",
      participants: 4,
      facts: 9,
      minutesPerWeek: 300,
      topOpportunities: [],
      solutionClassShare: { automation: 0.5, process: 0.25 },
    },
  ],
};

const SCENARIO_ERROR = {
  status: 500,
  body: { error: { code: "internal", message: "The analysis service did not answer." } },
};

function page(key: string, rows: unknown[]): Record<string, unknown> {
  return { [key]: rows, total: rows.length, limit: 50, offset: 0 };
}

const provider = (id: string, kind: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  name,
  baseUrl: kind === "openai_compatible" ? "https://llm.internal.example/v1" : null,
  enabled: true,
  hasKey: true,
  companyId: "c1",
  createdAt: EARLIER,
  ...extra,
});

const PROVIDERS = [
  provider("p1", "anthropic", "Anthropic"),
  provider("p2", "openrouter", "OpenRouter, EU region fallback with a long display name"),
  provider("p3", "openai_compatible", "Self-hosted gateway", { hasKey: false, enabled: false }),
  provider("p4", "local", "Local Whisper", { hasKey: false }),
];

const ROUTE_PURPOSES = [
  "interview_turn",
  "resume_summary",
  "extraction",
  "clustering",
  "analysis_report",
  "spec_turn",
  "spec_generation",
  "embedding",
  "transcription",
];

const ROUTES = ROUTE_PURPOSES.map((purpose, i) => ({
  companyId: i % 3 === 0 ? "c1" : null,
  purpose,
  providerId: purpose === "transcription" ? "p4" : i % 2 === 0 ? "p1" : "p2",
  model: purpose === "transcription" ? "whisper-small" : i % 2 === 0 ? "claude-sonnet" : "gpt-4.1-mini",
  maxOutputTokens: purpose === "transcription" ? 0 : 2048 * (1 + (i % 3)),
  batchAllowed: i % 4 === 1,
}));

const BUDGETS = [
  { id: "b1", scope: "tenant", scopeId: "c1", limitCents: 50000, period: "month", spentCents: 12500 },
  { id: "b2", scope: "campaign", scopeId: "camp1", limitCents: 10000, period: "total", spentCents: 8600 },
  { id: "b3", scope: "campaign", scopeId: "camp2", limitCents: 5000, period: "total", spentCents: 5200 },
  { id: "b4", scope: "session", scopeId: "sess0001abcdef", limitCents: 300, period: "total", spentCents: 40 },
];

const PRICES = [
  {
    providerId: "p1",
    model: "claude-sonnet",
    inputPerMtok: 3,
    cachedInputPerMtok: 0.3,
    outputPerMtok: 15,
    source: "provider",
  },
  {
    providerId: "p1",
    model: "claude-haiku",
    inputPerMtok: 0.8,
    cachedInputPerMtok: 0.08,
    outputPerMtok: 4,
    source: "seed",
  },
  {
    providerId: "p1",
    model: "claude-opus-with-a-very-long-model-identifier-2026-10",
    inputPerMtok: 15,
    cachedInputPerMtok: 1.5,
    outputPerMtok: 75,
    source: "admin",
  },
];

const statement = (month: string, cost: number) => ({
  companyId: "c1",
  month,
  generatedAt: `${month}-28T03:00:00.000Z`,
  currency: "EUR",
  lines: [
    {
      providerId: "p1",
      providerName: "Anthropic",
      model: "claude-sonnet",
      purpose: "interview_turn",
      calls: 640,
      inputTokens: 900000,
      cacheReadTokens: 400000,
      cacheWriteTokens: 60000,
      outputTokens: 120000,
      audioSeconds: 0,
      ttsCharacters: 0,
      costCents: cost - 2300,
      estimatedCents: 0,
    },
    {
      providerId: "p2",
      providerName: "OpenRouter",
      model: "gpt-4.1-mini",
      purpose: "extraction",
      calls: 240,
      inputTokens: 300000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 90000,
      audioSeconds: 0,
      ttsCharacters: 0,
      costCents: 2300,
      estimatedCents: 600,
    },
  ],
  totals: {
    costCents: cost,
    estimatedCents: 600,
    calls: 880,
    byPurpose: { interview_turn: cost - 2300, extraction: 2300 },
    byProvider: { Anthropic: cost - 2300, OpenRouter: 2300 },
    budgets: [
      {
        scope: "tenant",
        scopeId: "c1",
        name: null,
        period: "month",
        limitCents: 50000,
        spentCents: cost,
        hit: false,
      },
      {
        scope: "campaign",
        scopeId: "camp2",
        name: "Pharmacy 2025 Q3",
        period: "total",
        limitCents: 5000,
        spentCents: 5200,
        hit: true,
      },
    ],
  },
  counts: {
    sessionsStarted: 24,
    sessionsCompleted: 19,
    participants: 22,
    voiceMinutes: 85,
    storageBytes: 412 * 1024 * 1024,
    campaignsActive: 3,
    analysesRun: 7,
    specVersions: 4,
  },
});

const TENANTS = [
  {
    id: "c1",
    name: "Acme Care",
    status: "active",
    region: "eu",
    monthlyBudgetCents: 50000,
    createdAt: EARLIER,
    utilisation: [
      { metric: "maxActiveCampaigns", used: 3, max: 5, percent: 60 },
      { metric: "storageBytes", used: 412 * 1024 * 1024, max: 1024 * 1024 * 1024, percent: 40 },
    ],
    onboarding: { steps: [], done: 4, total: 4, complete: true, dismissed: false },
  },
  {
    id: "c2",
    name: "Northern Pharmacy Group with an unusually long company name that must wrap",
    status: "suspended",
    region: "eu",
    monthlyBudgetCents: 20000,
    createdAt: "2026-08-01T08:00:00.000Z",
    utilisation: [{ metric: "maxSessionsPerMonth", used: 195, max: 200, percent: 97 }],
    onboarding: { steps: [], done: 2, total: 4, complete: false, dismissed: false },
  },
  {
    id: "c3",
    name: "Vesi Health Oy",
    status: "active",
    region: "eu",
    monthlyBudgetCents: null,
    createdAt: "2026-09-12T08:00:00.000Z",
    utilisation: [],
    onboarding: null,
  },
];

const QUEUES = [
  {
    name: "analysis.run",
    queued: 0,
    active: 1,
    deadLettered: 0,
    oldestQueuedAt: null,
    expireInSeconds: 900,
    retryLimit: 2,
    lastFailure: null,
    runNow: false,
  },
  {
    name: "billing.statement",
    queued: 0,
    active: 0,
    deadLettered: 0,
    oldestQueuedAt: null,
    expireInSeconds: 600,
    retryLimit: 3,
    lastFailure: null,
    runNow: true,
  },
  {
    name: "tenant.export",
    queued: 2,
    active: 0,
    deadLettered: 1,
    oldestQueuedAt: "2026-10-14T07:00:00.000Z",
    expireInSeconds: 3600,
    retryLimit: 1,
    lastFailure: { at: "2026-10-14T06:30:00.000Z", jobId: "9f2d4b7e-0000-4000-8000-000000000001" },
    runNow: false,
  },
  {
    name: "email.send",
    queued: 14,
    active: 2,
    deadLettered: 0,
    oldestQueuedAt: "2026-10-14T09:20:00.000Z",
    expireInSeconds: 120,
    retryLimit: 5,
    lastFailure: null,
    runNow: false,
  },
];

const HEALTH = (name: string) => ({
  generatedAt: NOW,
  version: "2026.10.3",
  signals:
    name === "empty"
      ? []
      : [
          { key: "backup", status: "ok", detail: "Last backup 3 hours ago, copied off site", value: 3 },
          { key: "disk", status: "warn", detail: "Disk at 82 percent; the next warning is at 90", value: 82 },
          { key: "queue", status: "critical", detail: "One dead-lettered tenant export", value: 1 },
          { key: "certificate", status: "unknown", detail: "Not measured on this host", value: null },
        ],
  providers: [
    { providerId: "p1", name: "Anthropic", calls: 640, failed: 3, errorRate: 0.005, circuit: "closed" },
    { providerId: "p2", name: "OpenRouter", calls: 240, failed: 31, errorRate: 0.129, circuit: "half_open" },
  ],
  latency: {
    firstTokenP50Ms24h: 900,
    firstTokenP95Ms24h: 2600,
    firstTokenTargetMs: 2000,
    voiceFirstWordP95Ms24h: null,
    voiceFirstWordTargetMs: 1500,
  },
  backup: {
    lastResult: "ok",
    lastSuccessAt: "2026-10-14T05:00:00.000Z",
    ageHours: 3,
    offsite: "ok",
    drill: { result: "ok", at: "2026-10-12T03:00:00.000Z", error: null, durationS: 94 },
  },
  tenants: TENANTS.map((t, i) => ({
    companyId: t.id,
    name: t.name,
    status: t.status,
    sessionsThisMonth: 24 - i * 9,
    activeSessions: i === 0 ? 4 : 0,
    spendCents: 12500 - i * 5000,
    budgetLimitCents: t.monthlyBudgetCents,
    budgetFraction: t.monthlyBudgetCents ? (12500 - i * 5000) / t.monthlyBudgetCents : null,
    storageBytes: 412 * 1024 * 1024,
    voiceMinutes: 85,
    lastActivityAt: NOW,
    openCampaigns: 2,
    deadLetters24h: i === 0 ? 1 : 0,
    firstTokenP95Ms: 2100,
    utilisation: t.utilisation.map((u) => ({ ...u })),
  })),
});

/**
 * The scenario's answer for a read, or undefined when the default fake should answer. `name` is the
 * scenario; `path` has the API prefix stripped.
 */
export function scenarioRead(name: string, path: string): Out {
  const empty = name === "empty";
  const broken = name === "error";
  const long = name === "long";
  const withheld = name === "withheld";

  if (/^\/campaigns\/[^/]+\/analyses$/.test(path)) {
    if (broken) return SCENARIO_ERROR;
    return { body: page("analyses", analyses(name)) };
  }
  const detail = /^\/analyses\/([^/]+)$/.exec(path);
  if (detail) {
    if (broken) return SCENARIO_ERROR;
    const id = detail[1] ?? "an2";
    const list = analyses(name);
    const a = list.find((x) => x.id === id) ?? list[0];
    if (!a) return { status: 404, body: { error: { code: "not_found", message: "Analysis not found" } } };
    const opps = SEEDS.map((s) => opportunity(s, String(a.id), long, withheld));
    if (name === "preliminary") opps.length = 4;
    return {
      body: {
        analysis: a,
        opportunities: a.status === "done" ? opps : [],
        report:
          a.status === "done"
            ? {
                id: `r-${String(a.id)}`,
                analysisId: a.id,
                version: a.version,
                markdown: REPORT,
                sections: ["executive_summary", "participation", "opportunities", "not_ai", "next_steps"],
                createdAt: NOW,
              }
            : null,
      },
    };
  }
  if (/^\/analyses\/[^/]+\/departments$/.test(path)) {
    if (withheld)
      return { body: { shown: false, k: 3, belowK: 5, reason: "too_few_eligible", departments: [] } };
    if (name === "preliminary")
      return { body: { shown: false, k: 3, belowK: 2, reason: "below_k", departments: [] } };
    if (long) {
      const first = DEPARTMENTS.departments[0];
      return {
        body: {
          ...DEPARTMENTS,
          departments: [
            {
              ...first,
              name: "Front desk, patient registration, scheduling and the telephone exchange for the three outpatient buildings",
            },
            ...DEPARTMENTS.departments.slice(1),
          ],
        },
      };
    }
    return { body: DEPARTMENTS };
  }
  if (/^\/campaigns\/[^/]+\/cluster-edits$/.test(path)) {
    if (name === "default" || long)
      return {
        body: {
          edits: [
            {
              id: "e2",
              op: "merge",
              clusters: 2,
              title: "Handover summaries drafted from the shift notes",
              createdAt: NOW,
              revokedAt: null,
            },
            { id: "e1", op: "split", parts: 2, title: "Reminders", createdAt: EARLIER, revokedAt: NOW },
          ],
        },
      };
    return { body: { edits: [] } };
  }

  if (path === "/providers" || path === "/operator/providers") {
    if (broken) return SCENARIO_ERROR;
    return {
      body: {
        providers: empty
          ? []
          : path === "/providers"
            ? PROVIDERS
            : PROVIDERS.map((p) => ({ ...p, companyId: null })),
      },
    };
  }
  if (path === "/routes" || path === "/operator/routes") {
    if (broken) return SCENARIO_ERROR;
    return { body: { routes: empty ? [] : ROUTES } };
  }
  if (path === "/budgets") {
    if (broken) return SCENARIO_ERROR;
    return { body: page("budgets", empty ? [] : BUDGETS) };
  }
  if (/^\/(operator\/)?providers\/[^/]+\/prices$/.test(path)) {
    if (broken) return SCENARIO_ERROR;
    return { body: page("prices", empty ? [] : PRICES) };
  }
  if (/^\/(operator\/)?providers\/[^/]+\/models$/.test(path)) {
    return {
      body: {
        models: empty
          ? []
          : [
              {
                id: "claude-sonnet",
                name: "Claude Sonnet",
                inputPerMtok: 3,
                outputPerMtok: 15,
                contextWindow: 200000,
              },
              {
                id: "claude-haiku",
                name: "Claude Haiku",
                inputPerMtok: 0.8,
                outputPerMtok: 4,
                contextWindow: 200000,
              },
            ],
        stale: name === "stale",
        fetchedAt: NOW,
      },
    };
  }
  if (path === "/spend/statements") {
    if (broken) return SCENARIO_ERROR;
    return {
      body: {
        statements: empty
          ? []
          : [statement("2026-09", 15800), statement("2026-08", 11200), statement("2026-07", 9400)],
      },
    };
  }
  const st = /^\/spend\/statements\/(\d{4}-\d{2})$/.exec(path);
  if (st) return { body: { statement: statement(st[1] ?? "2026-09", 15800) } };
  const ost = /^\/operator\/statements\/(\d{4}-\d{2})$/.exec(path);
  if (ost) {
    return {
      body: {
        month: ost[1],
        statements: empty
          ? []
          : [
              statement(ost[1] ?? "2026-09", 15800),
              { ...statement(ost[1] ?? "2026-09", 4100), companyId: "c3" },
            ],
      },
    };
  }
  if (path === "/operator/tenants") {
    if (broken) return SCENARIO_ERROR;
    return { body: page("tenants", empty ? [] : TENANTS) };
  }
  if (/^\/operator\/tenants\/[^/]+\/exports$/.test(path)) {
    return {
      body: {
        exports: empty
          ? []
          : [
              {
                stamp: "20261012T030000Z",
                companyId: "c1",
                requestedBy: "u9",
                createdAt: "2026-10-12T03:00:00.000Z",
                keyId: "k1",
                bytes: 48_000_000,
                sha256: "9f2d4b7e0000000000000000000000000000000000000000000000000000abcd",
                signature: "aa",
                rows: { sessions: 24, messages: 812, facts: 142 },
                files: 31,
                skippedFiles: 0,
              },
            ],
      },
    };
  }
  if (path === "/operator/tenants/c1" || /^\/operator\/tenants\/[^/]+$/.test(path)) {
    const id = path.split("/").pop();
    const t = TENANTS.find((x) => x.id === id);
    if (!t) return { status: 404, body: { error: { code: "not_found", message: "Tenant not found" } } };
    return { body: { tenant: t } };
  }
  if (path === "/operator/jobs") {
    if (broken) return SCENARIO_ERROR;
    return { body: { queues: empty ? [] : QUEUES } };
  }
  if (path === "/operator/jobs/dead") {
    return {
      body: {
        queue: "tenant.export",
        jobs: empty
          ? []
          : [
              {
                id: "9f2d4b7e-0000-4000-8000-000000000001",
                queue: "tenant.export",
                createdAt: "2026-10-14T06:30:00.000Z",
                sourceId: null,
                retryCount: 1,
                companyId: "c2",
                data: { companyId: "c2", requestedBy: "u9" },
                error:
                  "Storage answered 507 Insufficient Storage while writing the sealed archive after 3.2 GiB.",
              },
            ],
      },
    };
  }
  if (path === "/operator/health") {
    if (broken) return SCENARIO_ERROR;
    return { body: HEALTH(name) };
  }
  if (path === "/operator/stats") {
    if (broken) return SCENARIO_ERROR;
    return {
      body: {
        platform: { tenants: 3, activeTenants: 2, sessions: 215, completedSessions: 168 },
        ai: { month: { costCents: 18300, calls: 1480, inputTokens: 2_100_000, outputTokens: 410_000 } },
      },
    };
  }
  return undefined;
}

export const SCENARIOS = [
  "default",
  "empty",
  "running",
  "autoqueued",
  "failed",
  "preliminary",
  "withheld",
  "long",
  "error",
] as const;
