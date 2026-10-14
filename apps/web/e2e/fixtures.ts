import opportunityDiscovery from "../../../packages/db/src/seed-templates/opportunity_discovery.json" with { type: "json" };

/*
 * Fixtures for the fake API (docs/spec/16 and 17): the smallest answers that make every page
 * render with content, so an accessibility check looks at a real screen and not at an error state.
 * `test/e2e-fixtures.test.ts` parses the shapes the pages read with the web app's own schemas, so a
 * contract change that breaks a fixture fails in the unit tests and not in a browser.
 */

export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://localhost:3100";
export const LINK_TOKEN = "e2e-link-token-open";

const NOW = "2026-10-14T09:30:00.000Z";
const EARLIER = "2026-10-10T08:00:00.000Z";

export const company = { id: "c1", name: "Acme Care" };

export const me = (role: "admin" | "member" | "platform_operator" = "admin"): Record<string, unknown> => ({
  user: { id: "u1", email: "ada@acme.test", name: "Ada Admin", role, companyId: "c1" },
  company,
});

export const template = {
  ...opportunityDiscovery,
  version: 3,
  id: "tpl1",
  companyId: "c1",
  status: "published",
  createdAt: EARLIER,
  updatedAt: NOW,
};

export const templateList = [
  {
    id: "tpl1",
    key: opportunityDiscovery.key,
    name: opportunityDiscovery.name,
    version: 3,
    companyId: "c1",
    status: "published",
    updatedAt: NOW,
  },
  {
    id: "tpl0",
    key: "requirements_discovery",
    name: "Requirements discovery",
    version: 1,
    companyId: null,
    status: "published",
    updatedAt: EARLIER,
  },
];

export const campaign = {
  id: "camp1",
  name: "Ward round, Q4",
  templateId: "tpl1",
  templateKey: opportunityDiscovery.key,
  templateVersion: 3,
  status: "open",
  participationMode: "participant_choice",
  verification: "email_code",
  allowedEmailDomains: ["acme.test"],
  maxTurns: 40,
  completionThreshold: 10,
  expiresAt: "2026-12-01T10:00:00.000Z",
  createdAt: EARLIER,
  link: { url: `${WEB_ORIGIN}/p/${LINK_TOKEN}` },
  stats: {
    invited: 24,
    started: 15,
    completed: 11,
    dropOffByArea: { daily_work: 2, tools: 1 },
  },
};

export const invitations = [
  {
    id: "i1",
    email: "kim@acme.test",
    status: "sent",
    sentAt: NOW,
    openedAt: null,
    expiresAt: "2026-11-30T00:00:00.000Z",
  },
  {
    id: "i2",
    email: "lee@acme.test",
    status: "bound",
    sentAt: EARLIER,
    openedAt: NOW,
    expiresAt: "2026-11-30T00:00:00.000Z",
  },
  {
    id: "i3",
    email: null,
    status: "sent",
    sentAt: NOW,
    openedAt: null,
    expiresAt: "2026-11-30T00:00:00.000Z",
  },
];

export const sessions = [
  {
    id: "sess0001abcdef",
    status: "completed",
    turns: 18,
    areasCovered: 5,
    mode: "voice",
    flagged: false,
    flagAckedAt: null,
    costCents: 14.2,
    participantName: "Aino Virtanen",
    participantEmail: "aino@acme.test",
    startedAt: EARLIER,
    endedAt: NOW,
    createdAt: EARLIER,
    lastActivityAt: NOW,
  },
  {
    id: "sess0002abcdef",
    status: "active",
    turns: 7,
    areasCovered: 2,
    mode: "chat",
    flagged: true,
    flagAckedAt: null,
    costCents: 3.1,
    participantName: null,
    participantEmail: null,
    startedAt: NOW,
    endedAt: null,
    createdAt: NOW,
    lastActivityAt: NOW,
  },
];

export const analysis = {
  id: "an1",
  campaignId: "camp1",
  version: 1,
  status: "done",
  preliminary: false,
  stats: { sessions: 11, facts: 142, clusters: 9, participants: 11, thresholdMet: true },
  startedAt: EARLIER,
  finishedAt: NOW,
  createdAt: EARLIER,
};

const factor = (score: number) => ({ score, rationale: "Observed in several interviews." });
export const opportunity = (
  id: string,
  title: string,
  cls: string,
  rank: number,
): Record<string, unknown> => ({
  id,
  analysisId: "an1",
  title,
  summary: "Nurses retype the same observations into two systems.",
  solutionClass: cls,
  rankScore: rank,
  status: "new",
  factors: {
    expected_impact: factor(4),
    affected_employees: factor(4),
    frequency: factor(5),
    implementation_complexity: factor(3),
    data_availability: factor(4),
    risk: factor(3),
    ai_suitability: factor(4),
  },
  rationale: "High frequency and a clear structured source.",
  evidence: [{ factId: "f1", snippet: "We type everything twice.", anonymized: true }],
  stats: {
    participants: 8,
    facts: 12,
    roles: ["Nurse"],
    departments: ["Ward"],
    tools: ["Spreadsheet"],
    minutesPerWeekTotal: 95,
    quotes: ["We type everything twice."],
  },
  participants: 8,
  minutesPerWeek: 95,
  roles: ["Nurse"],
  tools: ["Spreadsheet"],
  dataNeeded: ["Observation records"],
  risks: ["Patient data in transit"],
  whyNotAi: null,
  createdAt: NOW,
});

export const analysisDetail = {
  ...analysis,
  opportunities: [
    opportunity("op1", "Retyped observations", "automation", 86),
    opportunity("op2", "Handover summaries", "ai", 78),
    opportunity("op3", "Shift swap requests", "process", 51),
  ],
  report: { sections: [] },
};

export const settingsCatalog = [
  {
    key: "campaign.consentText",
    category: "campaign",
    description: "Consent text shown before the first turn",
    default: "",
    scopes: ["platform", "tenant", "campaign"],
    secret: false,
  },
  {
    key: "engine.maxTurns",
    category: "engine",
    description: "Turns at most",
    default: 40,
    scopes: ["platform", "tenant", "campaign", "template"],
    secret: false,
  },
  {
    key: "privacy.retentionMonths",
    category: "privacy",
    description: "Months before deletion",
    default: 24,
    scopes: ["platform", "tenant"],
    secret: false,
  },
  {
    key: "voice.enabled",
    category: "voice",
    description: "Voice answers",
    default: true,
    scopes: ["platform", "tenant", "template"],
    secret: false,
  },
  {
    key: "email.smtpUrl",
    category: "email",
    description: "smtp://user:pass@host:587",
    default: "",
    scopes: ["platform", "tenant"],
    secret: true,
  },
  {
    key: "email.from",
    category: "email",
    description: "Envelope sender for outgoing mail",
    default: "no-reply@example.com",
    scopes: ["platform", "tenant"],
    secret: false,
  },
  {
    key: "email.replyTo",
    category: "email",
    description: "Optional reply-to address",
    default: "",
    scopes: ["platform", "tenant"],
    secret: false,
  },
];

export const provider = {
  id: "p1",
  kind: "anthropic",
  name: "Anthropic",
  baseUrl: null,
  enabled: true,
  hasKey: true,
  companyId: "c1",
  createdAt: EARLIER,
};

export const routes = [
  {
    companyId: "c1",
    purpose: "interview_turn",
    providerId: "p1",
    model: "claude-sonnet",
    maxOutputTokens: 2048,
    batchAllowed: false,
  },
  {
    companyId: null,
    purpose: "clustering",
    providerId: "p1",
    model: "claude-sonnet",
    maxOutputTokens: 4096,
    batchAllowed: true,
  },
];

export const budgets = [
  { id: "b1", scope: "tenant", scopeId: "c1", limitCents: 50000, period: "month", spentCents: 12500 },
  { id: "b2", scope: "campaign", scopeId: "camp1", limitCents: 10000, period: "total", spentCents: 8600 },
];

export const users = [
  {
    id: "u1",
    email: "ada@acme.test",
    name: "Ada Admin",
    role: "admin",
    status: "active",
    createdAt: EARLIER,
  },
  {
    id: "u2",
    email: "ben@acme.test",
    name: "Ben Member",
    role: "member",
    status: "active",
    createdAt: EARLIER,
  },
];

export const tenants = [
  {
    id: "c1",
    name: "Acme Care",
    status: "active",
    region: "eu",
    monthlyBudgetCents: 50000,
    createdAt: EARLIER,
    utilisation: [{ metric: "maxActiveCampaigns", used: 2, max: 5, percent: 40 }],
  },
];

export const requirementsItem = {
  id: "req1",
  title: "Ward handover assistant",
  status: "active",
  path: "nontechnical",
  createdAt: EARLIER,
  updatedAt: NOW,
};

export const promptSummaries = [
  {
    key: "interviewer",
    group: "interview",
    shipped: { version: 5, tag: "interviewer@5", chars: 6374 },
    effective: { source: "tenant", version: 2, tag: "interviewer@t2" },
    canary: { version: 3, share: 0.2 },
    versions: 3,
    stats: { calls: 420, errors: 8, errorRate: 0.019, meanLatencyMs: 2100, meanCostCents: 0.9 },
  },
  {
    key: "summary",
    group: "interview",
    shipped: { version: 2, tag: "summary@2", chars: 1421 },
    effective: { source: "shipped", version: 2, tag: "summary@2" },
    canary: null,
    versions: 0,
    stats: { calls: 0, errors: 0, errorRate: 0, meanLatencyMs: 0, meanCostCents: 0 },
  },
];

const body = "You are an interviewer.\n{{objective}}\n{{language}}\n";
export const promptDetail = {
  key: "interviewer",
  group: "interview",
  shipped: { version: 5, tag: "interviewer@5", body, stats: promptSummaries[0]?.stats },
  contract: {
    requiredPlaceholders: ["objective", "language"],
    untrustedRules: true,
    contractTokens: ["<<<TURN_META>>>"],
    maxChars: 30000,
  },
  effective: { source: "tenant", version: 2, tag: "interviewer@t2" },
  canary: { version: 3, share: 0.2 },
  platform: null,
  versions: [
    {
      version: 3,
      tag: "interviewer@t3",
      note: "Plainer first message",
      body: `${body}Be brief.\n`,
      state: "canary",
      canaryShare: 0.2,
      parentVersion: 2,
      createdAt: NOW,
      createdBy: { id: "u1", name: "Ada Admin", email: "ada@acme.test" },
      activatedAt: NOW,
      deactivatedAt: null,
      stats: { calls: 40, errors: 1, errorRate: 0.025, meanLatencyMs: 2300, meanCostCents: 1 },
    },
    {
      version: 2,
      tag: "interviewer@t2",
      note: null,
      body,
      state: "stable",
      canaryShare: 1,
      parentVersion: null,
      createdAt: EARLIER,
      createdBy: null,
      activatedAt: EARLIER,
      deactivatedAt: null,
      stats: { calls: 380, errors: 7, errorRate: 0.018, meanLatencyMs: 2000, meanCostCents: 0.9 },
    },
  ],
  windowDays: 30,
};

/** The participant credential that gets the live call: the fake API reads "live" in it. */
export const LIVE_TOKEN = "e2e-participant-live";
export const PARTICIPANT_TOKEN = "e2e-participant-token";

export const participantSession = {
  id: "sess9",
  status: "active",
  path: null,
  modePreference: "chat",
  consented: true,
  progress: {
    areas: [
      { key: "role", name: "Your role", status: "covered" },
      { key: "daily_work", name: "A normal day", status: "partial" },
      { key: "tools", name: "Tools and systems", status: "untouched" },
    ],
  },
  messages: [
    {
      id: "m1",
      seq: 1,
      role: "assistant",
      modality: "text",
      content: "Hello! What is your role on the ward?",
      createdAt: EARLIER,
    },
    { id: "m2", seq: 2, role: "user", modality: "text", content: "I am a ward nurse.", createdAt: EARLIER },
    {
      id: "m3",
      seq: 3,
      role: "assistant",
      modality: "text",
      content: "Which of these takes most of your time?",
      widget: {
        type: "single_choice",
        options: [
          { key: "doc", label: "Documentation" },
          { key: "hand", label: "Handover" },
          { key: "meds", label: "Medication rounds" },
        ],
      },
      createdAt: NOW,
    },
  ],
  capabilities: {
    recordedVoice: true,
    liveVoice: false,
    captions: true,
    fileUpload: true,
    maxSizeMb: 20,
    allowedTypes: ["application/pdf"],
  },
  attachments: [],
  about: { name: "Ward round, Q4", purpose: "We want to understand how work really happens on your ward." },
  summary: null,
  recap: { text: "You covered your role. Next is a normal day.", source: "fallback" },
};

export const linkInfo = (status: "open" | "closed" | "expired" = "open"): Record<string, unknown> => ({
  campaign: {
    name: "Ward round, Q4",
    productName: "",
    purpose: "We want to understand how work really happens on your ward.",
    expectedMinutes: 15,
    participationMode: "participant_choice",
    verification: "open",
    consentText:
      "This interview is a conversation with an AI interviewer, run on behalf of your organization. Your answers are kept so that your organization can understand how work is actually done.",
    participantFields: [{ key: "role", label: "Role", required: true }],
    pathSelection: "none",
  },
  status,
});

/** What `/p/r/:token` answers for an invited requirements participant (contract 18). */
export const inviteArrival = {
  status: "open",
  session: {
    title: "Ward handover assistant",
    purpose: "",
    consentText: "Consent.",
    consentVersion: "v1",
    pathSelection: "none",
    productName: "",
    language: "en",
  },
};

const specVersionSummary = {
  id: "ver2",
  version: 2,
  label: "After the owner review",
  status: "done",
  error: null,
  createdBy: "Ada Admin",
  createdAt: NOW,
  finishedAt: NOW,
  stats: {
    sections: 3,
    requirements: 4,
    mvp: 3,
    future: 1,
    phases: 2,
    openFindings: 1,
    promptVersions: ["spec_generation@3"],
    generated: "model",
  },
};

export const specVersions = [
  specVersionSummary,
  {
    ...specVersionSummary,
    id: "ver1",
    version: 1,
    label: null,
    createdAt: EARLIER,
    finishedAt: EARLIER,
    stats: { ...specVersionSummary.stats, requirements: 3, mvp: 3, future: 0, openFindings: 3 },
  },
];

/**
 * One diagram of each type, drawn from the sources the generator wrote for a real demo run. The
 * diagram spec (`e2e/diagrams.spec.ts`) measures what Mermaid makes of them in a browser under the
 * enforced policy, so a layout that is not legible at a phone's width fails there.
 */
export const demoDiagrams = [
  {
    key: "context-1",
    title: "System context",
    type: "context",
    mermaid:
      "flowchart LR\n  Visitor((Visitor/Contractor)) -->|Scan QR & submit details| WebApp[Parking Pass Web App]\n  Reception -->|View & manage list| WebApp\n  ClinicManager -->|Export lists & view overrides| WebApp\n  WebApp -->|Stores data| GoogleSheets[(Google Sheets)]",
  },
  {
    key: "containers-1",
    title: "Containers",
    type: "containers",
    mermaid:
      "flowchart LR\n  subgraph User Devices\n    PhoneTablet[Phones and Tablets]\n  end\n  WebApp[Parking Pass Web Application]\n  GoogleSheets[(Google Sheets Storage)]\n\n  PhoneTablet --> WebApp\n  WebApp --> GoogleSheets",
  },
  {
    key: "sequence-1",
    title: "Check-in flow",
    type: "sequence",
    mermaid:
      "sequenceDiagram\n  Visitor->>WebApp: Scan QR code\n  WebApp->>Visitor: Show check-in form\n  Visitor->>WebApp: Submit name, car info, plate\n  WebApp->>GoogleSheets: Save record with timestamp\n  WebApp->>Visitor: Show confirmation with 5 PM expiry",
  },
  {
    key: "state-1",
    title: "Visitor status",
    type: "state",
    mermaid:
      "stateDiagram-v2\n  [*] --> OnSite\n  OnSite --> Flagged : Reception adds note\n  OnSite --> Left : Reception marks Left\n  Flagged --> Left\n  Left --> [*]",
  },
  {
    key: "entity-1",
    title: "Entities",
    type: "entity",
    mermaid:
      "erDiagram\n  VISITOR {\n    string Name\n    string CarMake\n    string CarModel\n    string LicensePlate\n    datetime CheckInTime\n    string Status\n    string FlagNote\n    boolean IsContractor\n    string OverrideNote\n  }\n  OVERRIDE {\n    string UserName\n    datetime Timestamp\n    string Reason\n  }\n  VISITOR ||--o{ OVERRIDE : logs",
  },
].map((d) => ({
  ...d,
  description: `The ${d.title.toLowerCase()} of the parking pass system.`,
  status: "generated",
  verified: true,
}));

/** `GET /requirements/:id`: the session, its transcript, the live spec, versions and invitations. */
export const requirementsDetail = {
  session: {
    id: "req1",
    title: "Ward handover assistant",
    status: "active",
    path: "nontechnical",
    sourceKind: "manual",
    ownerUserId: "u1",
    templateId: "tpl_req",
    language: "en",
    progress: {
      areas: [
        { key: "overview", name: "What it is for", status: "covered" },
        { key: "users", name: "Who uses it", status: "partial" },
        { key: "functional", name: "What it must do", status: "untouched" },
      ],
    },
    phase: "areas",
    createdAt: EARLIER,
    startedAt: EARLIER,
    endedAt: null,
  },
  messages: [
    {
      id: "rm1",
      seq: 1,
      role: "assistant",
      modality: "text",
      content: "What problem should this tool solve for the ward?",
      createdAt: EARLIER,
    },
    {
      id: "rm2",
      seq: 2,
      role: "user",
      modality: "text",
      content: "Handover notes get lost between shifts, so the next nurse starts blind.",
      createdAt: EARLIER,
    },
    {
      id: "rm3",
      seq: 3,
      role: "assistant",
      modality: "text",
      content: "Who reads the notes first, and on what device?",
      createdAt: NOW,
    },
  ],
  spec: {
    title: "Ward handover assistant",
    path: "nontechnical",
    context: { audience: "Ward nurses", scale: "40 nurses on three wards" },
    sections: [
      {
        key: "overview",
        title: "Overview",
        status: "draft",
        markdown:
          "Handover notes are written on paper and lost between shifts. The tool keeps one shared note per patient for the next shift.",
        fields: [
          {
            path: "overview.problem",
            value: "Handover notes are lost between shifts.",
            source: "user",
          },
        ],
      },
      {
        key: "users",
        title: "Users",
        status: "draft",
        markdown: "Ward nurses read the notes at the start of a shift, on a shared tablet.",
        fields: [{ path: "users.primary", value: "Ward nurses", source: "user" }],
      },
      { key: "functional", title: "Functional requirements", status: "empty", markdown: "", fields: [] },
    ],
    diagrams: [],
    findings: [
      {
        id: "f1",
        type: "ambiguity",
        section: "users",
        description: "It is not clear whether doctors also read the notes.",
        resolution: "Ask who besides nurses opens a handover note.",
        default: "Nurses only for the first version.",
        confidence: "medium",
        status: "open",
        pushedBack: false,
      },
    ],
    decisions: [
      {
        key: "d1",
        question: "Where are notes written?",
        choice: "On the shared ward tablet",
        source: "user",
      },
    ],
    mvpChallenge: { started: false, done: false, asked: [], outcome: "pending" },
    stats: { fields: 2, sectionsWithContent: 2, openFindings: 1 },
  },
  versions: specVersions,
  invitations: [
    {
      id: "rinv1",
      email: "charge.nurse@acme.test",
      status: "sent",
      sentAt: EARLIER,
      openedAt: null,
      expiresAt: "2026-11-14T09:30:00.000Z",
    },
  ],
};

/**
 * `GET /analyses/:id/departments`: two groups above k, with the long opportunity titles the demo
 * run produced. They are what clipped on the right of the results sidebar (D-321).
 */
export const departments = {
  shown: true,
  k: 3,
  belowK: 1,
  departments: [
    {
      name: "Front desk and patient registration",
      kind: "department",
      participants: 4,
      facts: 18,
      minutesPerWeek: 1_260,
      topOpportunities: [
        {
          clusterKey: "c1",
          title: "Automatic reminder messages for appointments that were rescheduled at short notice",
          share: 0.75,
        },
        { clusterKey: "c2", title: "Single entry of visitor details at the reception desk", share: 0.5 },
      ],
      solutionClassShare: { ai: 0.1, automation: 0.6, software: 0.2, process: 0.1 },
    },
    {
      name: "Nursing",
      kind: "department",
      participants: 3,
      facts: 12,
      minutesPerWeek: 540,
      topOpportunities: [],
      solutionClassShare: { automation: 0.67 },
    },
  ],
};

/** The same interview for a tenant that has live voice calls switched on. */
export const participantSessionLive = {
  ...participantSession,
  capabilities: { ...participantSession.capabilities, liveVoice: true },
};

/** `GET /requirements/:id/versions/:v`: one generated version, with its document text and bundle. */
export const specVersionDetail = {
  version: specVersionSummary,
  document: null,
  markdown:
    "# Ward handover assistant\n\n## Overview\n\nHandover notes are lost between shifts. The tool keeps one shared note per patient.\n\n## Requirements\n\n- R-001 A nurse can write a handover note for a patient.\n- R-002 The next shift sees the note first.\n",
  bundle: {
    format: "generic",
    files: [
      { path: "spec.md", content: "# Ward handover assistant\n\nOne shared note per patient.\n" },
      { path: "AGENTS.md", content: "# Working notes\n\nBuild what spec.md says, nothing more.\n" },
    ],
  },
  issues: [
    {
      id: "f1",
      type: "ambiguity",
      section: "users",
      description: "It is not clear whether doctors also read the notes.",
      resolution: "Ask who besides nurses opens a handover note.",
      default: "Nurses only for the first version.",
      confidence: "medium",
      status: "open",
      pushedBack: false,
    },
  ],
};

/**
 * The same session and version with the five diagrams drawn, served for the id `reqd` only. The
 * accessibility pass keeps `req1`: Mermaid measures a diagram in a style element of its own that a
 * nonce-only policy refuses, which is a known report (D-320) and not what that pass is checking.
 */
export const requirementsDetailWithDiagrams = {
  ...requirementsDetail,
  spec: { ...requirementsDetail.spec, diagrams: demoDiagrams },
};

export const specVersionDetailWithDiagrams = {
  ...specVersionDetail,
  markdown: `${specVersionDetail.markdown}\n## Diagrams\n\n${demoDiagrams
    .map((d) => `### ${d.title}\n\n\`\`\`mermaid\n${d.mermaid}\n\`\`\`\n`)
    .join("\n")}`,
};
