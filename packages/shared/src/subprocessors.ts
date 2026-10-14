import { PROVIDER_KINDS, type ProviderKind } from "./providers.js";
import { SETTINGS } from "./settings.js";

/**
 * Who may process personal data on the platform's behalf, derived from what the code can connect
 * to (GDPR Art. 28 and 30, D-166). `docs/SUBPROCESSORS.md` and `docs/PRIVACY-PROCESSING.md` are
 * generated from this file; a test fails when they differ from it, and when a provider kind has
 * no entry, so a new integration cannot ship without saying who receives what.
 *
 * Vendor facts here are the vendors' public positions as the owner must confirm them before a
 * deployment relies on them; they are not legal advice and are not a substitute for the DPA.
 */
export interface SubProcessor {
  /** Vendor name, or "None (runs on the platform's own server)". */
  vendor: string;
  role: string;
  /** Where processing happens, as far as the vendor publishes it. */
  location: string;
  /** What personal data reaches it. */
  data: string[];
  transfer: string;
  /** Whether a tenant chooses to use it. Optional ones appear only when configured. */
  optional: boolean;
}

export const PROVIDER_SUBPROCESSORS: Record<ProviderKind, SubProcessor> = {
  anthropic: {
    vendor: "Anthropic",
    role: "Language model: interviewer turns, summaries, extraction, analysis",
    location: "United States (see vendor's data-residency options)",
    data: ["Interview answers and file summaries as prompt text", "Pseudonymous session context"],
    transfer:
      "Outside the EEA: standard contractual clauses or the vendor's equivalent; confirm in the vendor's DPA",
    optional: true,
  },
  openai: {
    vendor: "OpenAI",
    role: "Language, speech-to-text, text-to-speech, realtime voice and embeddings",
    location: "United States (see vendor's data-residency options)",
    data: ["Answers as prompt text", "Voice audio and its transcript", "Document text for embeddings"],
    transfer:
      "Outside the EEA: standard contractual clauses or the vendor's equivalent; confirm in the vendor's DPA",
    optional: true,
  },
  openrouter: {
    vendor: "OpenRouter and the model vendor it routes to",
    role: "Language model gateway",
    location: "Depends on the model vendor chosen per route",
    data: ["Interview answers and file summaries as prompt text"],
    transfer: "Two processors in a chain; confirm both and the routing policy",
    optional: true,
  },
  litellm: {
    vendor: "The organization's own LiteLLM gateway, and the vendors behind it",
    role: "Language model gateway operated by the tenant",
    location: "Chosen by the tenant",
    data: ["Interview answers and file summaries as prompt text"],
    transfer: "Determined by the tenant's gateway configuration",
    optional: true,
  },
  openai_compatible: {
    vendor: "Any OpenAI-compatible endpoint the tenant configures",
    role: "Language model, as configured",
    location: "Chosen by the tenant",
    data: ["Interview answers and file summaries as prompt text"],
    transfer: "Determined by the endpoint the tenant names; the platform operator must approve it",
    optional: true,
  },
  stt: {
    vendor: "The speech-to-text vendor the tenant configures",
    role: "Transcription of recorded answers",
    location: "Chosen by the tenant",
    data: ["Voice audio", "Transcript"],
    transfer: "Determined by the vendor named",
    optional: true,
  },
  tts: {
    vendor: "The text-to-speech vendor the tenant configures",
    role: "Spoken interviewer voice",
    location: "Chosen by the tenant",
    data: ["Interviewer text (may paraphrase an answer)"],
    transfer: "Determined by the vendor named",
    optional: true,
  },
  realtime: {
    vendor: "The realtime-voice vendor the tenant configures",
    role: "Live voice conversation",
    location: "Chosen by the tenant",
    data: ["Live voice audio", "Transcript"],
    transfer: "Determined by the vendor named",
    optional: true,
  },
  local: {
    vendor: "None (runs on the platform's own server)",
    role: "Transcription of recorded answers with Whisper on the API host",
    location: "The platform's own server",
    data: ["Voice audio, processed in memory"],
    transfer: "None: audio does not leave the server",
    optional: true,
  },
};

/** Infrastructure that is always part of a deployment, whichever providers are configured. */
export const INFRASTRUCTURE_SUBPROCESSORS: { name: string; entry: SubProcessor }[] = [
  {
    name: "Hosting",
    entry: {
      vendor: "The VPS provider chosen by the operator (EU region for the reference deployment)",
      role: "Runs the application, the database, file storage and backups",
      location: "European Union (operator's choice; confirm per deployment)",
      data: ["Everything the platform stores"],
      transfer: "None when hosted in the EEA",
      optional: false,
    },
  },
  {
    name: "Email",
    entry: {
      vendor: "The SMTP service the operator or tenant configures",
      role: "Invitations, verification codes and notifications",
      location: "Chosen by the operator",
      data: ["Email address", "Message text"],
      transfer: "Determined by the SMTP service",
      optional: false,
    },
  },
  {
    name: "Certificates",
    entry: {
      vendor: "Let's Encrypt (through Caddy)",
      role: "TLS certificate issuance",
      location: "United States",
      data: ["The public hostname only; no personal data"],
      transfer: "None: no personal data",
      optional: false,
    },
  },
];

/** The processing record (Art. 30), as rows. Retention figures are read from the settings catalog. */
export interface ProcessingActivity {
  name: string;
  purpose: string;
  subjects: string;
  categories: string[];
  recipients: string;
  retention: string;
  security: string;
}

export function processingRecord(): ProcessingActivity[] {
  const months = SETTINGS["privacy.retentionMonths"].default;
  const audioDays = SETTINGS["privacy.audioRetentionDays"].default;
  const k = SETTINGS["privacy.kAnonymity"].default;
  return [
    {
      name: "Interviews",
      purpose:
        "Collecting how work is done, in the participant's words, for the organization that invited them",
      subjects: "Participants invited by a customer organization",
      categories: [
        "Answers and the conversation transcript",
        "Fields the participant enters (name, role, department, email) as the interview template asks",
        "Consent record: version and time",
        "Files and voice recordings they attach",
      ],
      recipients:
        "The organization's administrators (by role and privacy mode); the sub-processors in SUBPROCESSORS.md",
      retention: `${months} months after the interview ends, then deleted; voice recordings after ${audioDays} days unless a tenant sets otherwise; the participant may delete at any time`,
      security:
        "Tenant isolation by row-level security, encryption at rest for secrets, TLS in transit, access by role, audit log",
    },
    {
      name: "Analysis",
      purpose: "Combining many interviews into themes and ranked opportunities",
      subjects: "Participants of one campaign",
      categories: [
        "Facts extracted from answers",
        "Short quotes, shown only where at least " + String(k) + " people support a theme",
      ],
      recipients: "The organization's administrators",
      retention: "With the campaign; quotes are replaced with a marker when a participant deletes their data",
      security: "Evidence below the anonymity threshold is withheld; reports are role-gated",
    },
    {
      name: "Staff accounts",
      purpose: "Letting an organization's staff run campaigns and read results",
      subjects: "Staff of customer organizations and the platform operator",
      categories: ["Email address, name, role", "Audit log of administrative actions"],
      recipients: "The organization's administrators; the platform operator",
      retention: "While the account exists; audit log is append-only and kept with the organization",
      security: "Magic-link or Google sign-in, immediate disable and delete, hash-chained audit log",
    },
    {
      name: "Operations",
      purpose: "Running, securing and billing the service",
      subjects: "All of the above",
      categories: ["Request logs without answer content", "Model usage and cost ledger by session id"],
      recipients: "The platform operator",
      retention: "Logs are rotated by the host; the ledger follows the session",
      security: "Logs carry no answer content; ledger holds counts and costs only",
    },
  ];
}

/** Renders `docs/SUBPROCESSORS.md`. Deterministic, so a test can compare it with the file. */
export function renderSubprocessors(): string {
  const out: string[] = [];
  out.push(
    "# Sub-processors",
    "",
    "<!-- Generated by `pnpm docs:privacy` from packages/shared/src/subprocessors.ts. Do not edit. -->",
    "",
    "Who may process personal data on the platform's behalf. A tenant sees only the providers it has",
    "configured; this is the complete set the software can connect to.",
    "",
    "> This is a draft for the controller and counsel to confirm vendor by vendor. It is not legal advice.",
    "",
    "## Model and voice providers (chosen per tenant)",
    "",
    "| Kind | Vendor | Role | Location | Personal data | Transfer |",
    "| ---- | ------ | ---- | -------- | ------------- | -------- |",
  );
  for (const kind of PROVIDER_KINDS) {
    const p = PROVIDER_SUBPROCESSORS[kind];
    out.push(`| ${kind} | ${p.vendor} | ${p.role} | ${p.location} | ${p.data.join("; ")} | ${p.transfer} |`);
  }
  out.push("", "## Infrastructure (part of every deployment)", "");
  out.push(
    "| Service | Vendor | Role | Location | Personal data | Transfer |",
    "| ------- | ------ | ---- | -------- | ------------- | -------- |",
  );
  for (const { name, entry: p } of INFRASTRUCTURE_SUBPROCESSORS) {
    out.push(`| ${name} | ${p.vendor} | ${p.role} | ${p.location} | ${p.data.join("; ")} | ${p.transfer} |`);
  }
  out.push("");
  return out.join("\n");
}

/** Renders `docs/PRIVACY-PROCESSING.md`, the Article 30 record. */
export function renderProcessingRecord(): string {
  const out: string[] = [];
  out.push(
    "# Record of processing activities",
    "",
    "<!-- Generated by `pnpm docs:privacy` from packages/shared/src/subprocessors.ts and the settings",
    "     catalog defaults. Do not edit. -->",
    "",
    "GDPR Art. 30(2): the processor's record. Figures are the platform defaults; a tenant may set a",
    "shorter retention. Draft for the controller and counsel to confirm.",
    "",
  );
  for (const a of processingRecord()) {
    out.push(
      `## ${a.name}`,
      "",
      `- **Purpose:** ${a.purpose}`,
      `- **Data subjects:** ${a.subjects}`,
      "- **Categories of personal data:**",
      ...a.categories.map((c) => `  - ${c}`),
      `- **Recipients:** ${a.recipients}`,
      `- **Retention:** ${a.retention}`,
      `- **Security measures:** ${a.security}`,
      "",
    );
  }
  out.push(
    "## Transfers",
    "",
    "See [SUBPROCESSORS.md](SUBPROCESSORS.md) for each provider's location and transfer mechanism.",
    "",
  );
  return out.join("\n");
}
