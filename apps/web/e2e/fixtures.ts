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
  evidence: [{ quote: "We type everything twice.", participantRole: "Nurse" }],
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
    purpose: "analysis_cluster",
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
