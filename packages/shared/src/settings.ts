import { z } from "zod";
import { DEFAULT_WELCOME_TEXT } from "./welcome.js";

/**
 * The settings catalog. Every admin knob in the specification is a typed key with a
 * default and the scopes it may be set at. The admin UI renders from this catalog, the
 * settings service validates against it, and code reads through it. Adding a knob is
 * adding a row here.
 */
export const SETTING_SCOPES = ["platform", "tenant", "template", "campaign"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export interface SettingDef<T extends z.ZodType = z.ZodType> {
  schema: T;
  default: z.infer<T>;
  scopes: readonly SettingScope[];
  category: string;
  description: string;
  /** Encrypted at rest and never returned in plain text; the API answers with SECRET_SENTINEL. */
  secret?: boolean;
  /**
   * The release in which the key first shipped (`RELEASES`). The "what changed" panel lists keys
   * newer than the one an admin last saw, and a test refuses a key that is neither in the
   * baseline nor carries this (D-180).
   */
  since?: string;
  /**
   * Written only by the platform operator, at any scope. A tenant admin sees the value read-only.
   * Used for the tenant ceilings, which are a promise the operator makes about the platform.
   */
  operatorOnly?: boolean;
}

/** Release ids a `since` may name, newest last. The panel offers "new since" from this list. */
export const RELEASES = ["2026.10"] as const;
export type ReleaseId = (typeof RELEASES)[number];
export const CURRENT_RELEASE: ReleaseId = "2026.10";

/**
 * Placeholder the API returns instead of a secret value, and accepts back on a write to mean
 * "leave this one as it is". A literal value equal to the sentinel can therefore not be stored.
 */
export const SECRET_SENTINEL = "__unchanged__";

const def = <T extends z.ZodType>(d: SettingDef<T>): SettingDef<T> => d;

/**
 * Currencies a tenant can label its costs with (D-323). The ledger holds hundredths of the unit the
 * provider price table was entered in, and the shipped prices are US dollars per million tokens, so
 * the default is USD. Choosing another one does not convert anything: it says what the prices
 * the operator typed in are in.
 */
export const CURRENCIES = ["USD", "EUR", "GBP", "SEK", "NOK", "DKK", "CHF"] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = "USD";

/** An SMTP connection string the server is willing to dial: a real host, an SMTP scheme, a sane port. */
export function isSmtpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return false;
  if (!url.hostname) return false;
  if (url.port !== "" && !/^\d{1,5}$/.test(url.port)) return false;
  return url.port === "" || Number(url.port) > 0;
}

/**
 * The most a single upload can ever be, whatever a tenant sets (S6, D-87). Every layer in front
 * of the files enforces its own cap off this number: Caddy and the web proxy size their bodies
 * from it, the API's multipart ceiling is it, and `files.maxSizeMb` cannot be set above it.
 */
export const PLATFORM_MAX_UPLOAD_MB = 50;

/** A deliberately plain address check: one @, no spaces, a dot in the domain. Delivery is the real test. */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

/** An http or https URL with a host; the operator's alert endpoint, not a participant-supplied one. */
export function isHttpUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
}

/**
 * The consent shown when no one has written their own, by interview language. The wording is
 * `docs/team/plan/consent-default.md`, checked against what deletion does today: it removes the
 * answers, recordings and files, and no deletion email is promised (D-119). Changing a word here
 * changes the hash recorded at consent, so people who agreed earlier keep the hash of the words
 * they agreed to (D-185).
 */
export const DEFAULT_CONSENT_TEXT = {
  en: "This interview is a conversation with an AI interviewer, run on behalf of your organization. Your answers, any files you attach and any voice recordings are kept so that your organization can understand how work is actually done. They are processed by the AI services your organization has chosen. You can pause, stop or delete your answers at any time from the interview menu; deleting removes your answers, recordings and files right away, while totals already combined with other people's answers remain and cannot be traced to you. Your data is deleted automatically after your organization's retention period.",
  fi: "Tämä haastattelu on keskustelu tekoälyhaastattelijan kanssa, ja se tehdään organisaatiosi toimeksiannosta. Vastauksesi, liittämäsi tiedostot ja mahdolliset äänitallenteet säilytetään, jotta organisaatiosi ymmärtää, miten työ oikeasti tehdään. Niitä käsittelevät organisaatiosi valitsemat tekoälypalvelut. Voit keskeyttää, lopettaa tai poistaa vastauksesi milloin tahansa haastattelun valikosta. Poisto hävittää vastauksesi, tallenteesi ja tiedostosi heti; muiden vastauksiin jo yhdistetyt lukumäärät säilyvät, mutta niitä ei voi yhdistää sinuun. Tietosi poistetaan automaattisesti organisaatiosi säilytysajan jälkeen.",
} as const;

/** The default consent for an interview language; any language but Finnish gets English. */
export function defaultConsentText(language: string | null | undefined): string {
  return language?.toLowerCase().startsWith("fi") ? DEFAULT_CONSENT_TEXT.fi : DEFAULT_CONSENT_TEXT.en;
}

export const SETTINGS = {
  // Engine
  "engine.recentWindowTurns": def({
    schema: z.number().int().min(2).max(40),
    default: 10,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Verbatim turns kept in context",
  }),
  "engine.inputTokenBudget": def({
    schema: z.number().int().min(2000).max(200000),
    default: 12000,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Per-turn input token budget for context assembly",
  }),
  "engine.summarizeEveryTurns": def({
    schema: z.number().int().min(2).max(50),
    default: 6,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "How often the rolling summary is updated",
  }),
  "engine.extractEveryTurns": def({
    schema: z.number().int().min(1).max(20),
    default: 3,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "How often facts are extracted into state",
  }),
  "engine.maxTurns": def({
    schema: z.number().int().min(5).max(500),
    default: 60,
    scopes: ["platform", "tenant", "template", "campaign"],
    category: "engine",
    description: "Hard cap on interviewer turns",
  }),
  "engine.resumeRecap": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Show a short recap when a participant comes back to an interview",
    since: "2026.10",
  }),
  "engine.recapAfterMinutes": def({
    schema: z.number().int().min(0).max(1440),
    default: 5,
    scopes: ["platform", "tenant", "template"],
    category: "engine",
    description: "Minutes away before the recap is shown (0 shows it whenever the interview is reopened)",
    since: "2026.10",
  }),
  // Campaign
  "campaign.completionThreshold": def({
    schema: z.number().int().min(1).max(10000),
    default: 5,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Completed interviews before analysis runs",
  }),
  "campaign.completionThresholdPercent": def({
    schema: z.number().int().min(1).max(100),
    default: 30,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Percent of invited before analysis runs",
  }),
  "analysis.autoRunDelayMinutes": def({
    schema: z.number().int().min(0).max(240),
    default: 5,
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description:
      "Minutes to wait after an interview completes before the automatic analysis starts (0 = at once)",
    since: "2026.10",
  }),
  "campaign.linkExpiryDays": def({
    schema: z.number().int().min(1).max(365),
    default: 30,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Days an invitation or share link stays valid",
  }),
  "campaign.verification": def({
    schema: z.enum(["invitation", "email_code", "open"]),
    default: "email_code",
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "How one response per person is enforced on share links",
  }),
  "campaign.allowedEmailDomains": def({
    schema: z.array(z.string()),
    default: [],
    scopes: ["tenant", "campaign"],
    category: "campaign",
    description: "Restrict share links to these email domains; empty allows all",
  }),
  // The stored default is the English text; `defaultConsentText(language)` is what the participant
  // flow shows when nothing was set at any scope, so a Finnish template gets the Finnish words
  // (D-185). An explicit value, at any scope, is always shown as typed.
  "campaign.consentText": def({
    schema: z.string().min(1),
    default: DEFAULT_CONSENT_TEXT.en,
    scopes: ["platform", "tenant", "campaign"],
    category: "campaign",
    description: "Consent text shown before the first turn",
  }),
  // Campaign scope only: a welcome is about one campaign. Unset, the participant flow shows
  // `defaultWelcomeText(kind, language)` (D-460, D-461); the stored default is the English
  // discovery text so the catalog has a value to show.
  "campaign.welcomeText": def({
    schema: z.string().trim().min(1).max(2000),
    default: DEFAULT_WELCOME_TEXT.discovery.en,
    scopes: ["campaign"],
    category: "campaign",
    description: "Welcome text participants read before they start (never the interviewer's objective)",
    since: "2026.10",
  }),
  // Privacy
  // Enforced by the daily `privacy.retention-sweep` job (packages/core/src/privacy/retention.ts).
  "privacy.retentionMonths": def({
    schema: z.number().int().min(1).max(120),
    default: 24,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Months before session data is deleted automatically",
  }),
  "privacy.kAnonymity": def({
    schema: z.number().int().min(1).max(50),
    default: 3,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Minimum participants behind any quote or breakdown",
  }),
  "privacy.rawTranscriptsVisibleTo": def({
    schema: z.enum(["nobody", "admins", "admins_when_identified_and_opted_in"]),
    default: "admins_when_identified_and_opted_in",
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Who may open raw transcripts",
  }),
  // Enforced by the nightly sweep since phase 4. The transcript is the durable record and stays
  // with the session; this is only about how long the recording of someone's voice is kept, which
  // is the more identifying of the two.
  "privacy.audioRetentionDays": def({
    schema: z.number().int().min(0).max(3650),
    default: 365,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Days a voice recording is kept; 0 deletes it as soon as it is transcribed",
  }),
  // Abuse limits on the email-code flow (S1, D-82). Counted per address and campaign from the
  // EmailCode rows themselves, so they hold across restarts and across API replicas.
  "privacy.codeRequestsPerHour": def({
    schema: z.number().int().min(1).max(20),
    default: 3,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Verification codes one email address may request per hour for one campaign",
  }),
  "privacy.codeFailuresPerHour": def({
    schema: z.number().int().min(1).max(100),
    default: 10,
    scopes: ["platform", "tenant"],
    category: "privacy",
    description: "Wrong codes accepted per email address and campaign in an hour before it is locked",
  }),
  // Abuse limits on open links (A1, D-261). Counted in Postgres (UsageCounter), so they hold across
  // restarts and replicas. A refused open answers 429 and raises `abuse.limit_hit`.
  "abuse.campaignSessionsPerHour": def({
    schema: z.number().int().min(1).max(100000),
    // 120 until D-311: a drill with the default limits refused 311 of 499 open attempts when a
    // campaign was announced to a company (100 in a minute, then the people arriving behind them).
    default: 300,
    scopes: ["platform", "tenant", "campaign"],
    category: "privacy",
    since: "2026.10",
    description: "New interviews one campaign may start per hour, whatever the number of addresses",
  }),
  "abuse.campaignSessionsTotal": def({
    schema: z.number().int().min(1).max(1000000),
    default: 2000,
    scopes: ["platform", "tenant", "campaign"],
    category: "privacy",
    since: "2026.10",
    description: "Interviews one campaign may have in all; a cost ceiling for a link that leaks",
  }),
  "abuse.tenantSessionsPerHour": def({
    schema: z.number().int().min(1).max(100000),
    default: 1000,
    scopes: ["platform", "tenant"],
    category: "privacy",
    since: "2026.10",
    description: "New interviews all of an organization's campaigns together may start per hour",
  }),
  "abuse.distinctEmailsPerAddressPerHour": def({
    // 5 until D-468: colleagues in one office share one internet address, and in the 2026-10-15
    // simulation the sixth person to ask for a code within the hour silently got none. 50 still
    // stops one address mail-bombing a victim list; a bigger office raises it per tenant.
    schema: z.number().int().min(1).max(1000),
    default: 50,
    scopes: ["platform", "tenant"],
    category: "privacy",
    since: "2026.10",
    description: "Different email addresses one client address may ask a code for per hour and campaign",
  }),
  // Cost
  "cost.warnFraction": def({
    schema: z.number().min(0.1).max(1),
    default: 0.8,
    scopes: ["platform", "tenant"],
    category: "cost",
    description: "Fraction of a budget at which admins are warned",
  }),
  // There is deliberately no "what to do at 100 percent" knob (D-91). A budget is a promise about
  // money, so an exhausted one pauses the interview and tells the tenant's admins and the
  // operator; spending on a cheaper model after the limit would still be spending nobody
  // authorised. The only honest variant is a second, lower budget line, which already exists.
  "cost.probeMaxPerDay": def({
    schema: z.number().int().min(0).max(10000),
    default: 50,
    scopes: ["platform", "tenant"],
    category: "cost",
    description: "Provider connection tests a tenant may run per rolling day; 0 turns the test button off",
  }),
  "cost.defaultMonthlyBudgetCents": def({
    schema: z.number().int().min(0),
    default: 20000,
    scopes: ["platform"],
    category: "cost",
    description: "Default monthly tenant budget",
  }),
  // Files and voice
  "files.maxSizeMb": def({
    schema: z.number().int().min(1).max(PLATFORM_MAX_UPLOAD_MB),
    default: 20,
    scopes: ["platform", "tenant"],
    category: "files",
    description: "Maximum upload size",
  }),
  "files.allowedTypes": def({
    schema: z.array(z.string()),
    default: [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/markdown",
      "text/plain",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "image/png",
      "image/jpeg",
    ],
    scopes: ["platform", "tenant"],
    category: "files",
    description: "Accepted MIME types",
  }),
  "files.maxPerSession": def({
    schema: z.number().int().min(1).max(100),
    default: 10,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Attachments one interview may hold",
  }),
  "files.maxSessionMb": def({
    schema: z.number().int().min(1).max(1000),
    default: 100,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Total size of one interview's attachments (MB)",
  }),
  "files.tenantQuotaMb": def({
    schema: z.number().int().min(1).max(1048576),
    default: 5120,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Total size of all of an organization's attachments (MB)",
  }),
  "files.maxExtractedChars": def({
    schema: z.number().int().min(1000).max(5000000),
    default: 500000,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Text kept from one file",
  }),
  "files.maxPdfPages": def({
    schema: z.number().int().min(1).max(2000),
    default: 200,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Longest PDF that is read, in pages",
  }),
  "files.maxZipRatio": def({
    schema: z.number().int().min(2).max(1000),
    default: 100,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Largest unpacked-to-packed ratio for a part of a Word or Excel file",
  }),
  "files.maxSheetCells": def({
    schema: z.number().int().min(1000).max(20000000),
    default: 1000000,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Most cells read from a workbook",
  }),
  "files.maxZipEntries": def({
    schema: z.number().int().min(10).max(20000),
    default: 2000,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Most parts a Word or Excel file may contain",
  }),
  "files.maxUncompressedMb": def({
    schema: z.number().int().min(1).max(1024),
    default: 100,
    scopes: ["platform", "tenant"],
    category: "files",
    since: "2026.10",
    description: "Most a Word or Excel file may unpack to (MB)",
  }),
  "voice.targetFirstWordMs": def({
    schema: z.number().int().min(300).max(5000),
    default: 1500,
    scopes: ["platform", "tenant"],
    category: "voice",
    description: "Latency target for real-time voice",
  }),
  "voice.captions": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Show what was said and heard as text during a live voice interview",
  }),
  "voice.voiceName": def({
    schema: z.string().max(80),
    default: "alloy",
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Which of the speech model's voices the interviewer uses",
  }),
  "voice.speakingRate": def({
    schema: z.number().min(0.5).max(2),
    default: 1.05,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    // Slightly quick: an interviewer that reads at a measured pace sounds like it is dictating.
    description: "Speaking rate of the interviewer's voice, 1 is the model's normal pace",
  }),
  "voice.endOfSpeechMs": def({
    schema: z.number().int().min(200).max(3000),
    default: 700,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    // Short enough that the interviewer answers promptly, long enough that a breath mid-sentence
    // does not end the answer. Only the streaming path uses it; the provider detects the silence.
    description: "Silence that ends a spoken answer in a live call with streaming captions, in milliseconds",
  }),
  "voice.bargeIn": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "template"],
    category: "voice",
    description: "Participant can interrupt the interviewer",
  }),
  // Features
  "features.optionsView": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Widgets and options view",
  }),
  "features.recordedVoice": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Recorded voice answers",
  }),
  "features.realtimeVoice": def({
    schema: z.boolean(),
    default: false,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Live voice mode",
  }),
  "features.fileUpload": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "File attachments",
  }),
  "features.chaining": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "features",
    description: "Start one template from another's outputs",
  }),
  // Branding
  "branding.productName": def({
    schema: z.string().min(1),
    default: "AIScope",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Product name shown on the site and to participants",
  }),
  "branding.primaryColor": def({
    schema: z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour as #rrggbb"),
    default: "#1f4e79",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Accent colour of PDF exports",
    since: "2026.10",
  }),
  "branding.currency": def({
    schema: z.enum(CURRENCIES),
    default: DEFAULT_CURRENCY,
    scopes: ["platform", "tenant"],
    category: "branding",
    description:
      "The currency the model price table is entered in, and so the unit of every cost shown. A label, not a conversion",
    since: "2026.10",
  }),
  "branding.emailSender": def({
    schema: z.string(),
    default: "",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Deprecated: superseded by email.from, which falls back to this when it is unset",
  }),
  // Email. The port resolves these per send, tenant first and platform second, and falls back
  // to the deployment relay (SMTP_HOST and friends, see resolveSmtpEnv) and EMAIL_FROM.
  "email.smtpUrl": def({
    // Validated rather than free text: this string becomes an outbound connection from inside the
    // platform network, so an unchecked value is a port scanner with an authenticated trigger.
    schema: z.string().refine((v) => v === "" || isSmtpUrl(v), {
      message: "Must be smtp://host:port or smtps://host:port",
    }),
    default: "",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "smtp://user:pass@host:587; empty falls back to the environment, then the console",
    secret: true,
  }),
  "email.from": def({
    schema: z.string(),
    default: "no-reply@example.com",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "Envelope sender for outgoing mail",
  }),
  "email.replyTo": def({
    schema: z.string(),
    default: "",
    scopes: ["platform", "tenant"],
    category: "email",
    description: "Optional reply-to address",
  }),
  // Sales: the public "Request a pilot" form (`/pilot`). Platform only, because it names the
  // operator's own inbox and no tenant is involved in a request from a stranger.
  "sales.pilotRequestEmail": def({
    schema: z.string().refine((v) => v === "" || isEmailAddress(v), { message: "Must be an email address" }),
    default: "",
    scopes: ["platform"],
    category: "sales",
    description:
      "Where pilot requests from the public form are emailed; empty falls back to PILOT_REQUEST_EMAIL, then to the alert address (ops.alertEmail, ALERT_EMAIL)",
    since: "2026.10",
  }),
  // Operations (D-90). Platform only: these decide who the operator is told, how loudly, and how
  // often. `deploy/ops/notify.sh` cannot read this catalog (it has to work when the database does
  // not), so ALERT_EMAIL and ALERT_WEBHOOK_URL in .env are its copy and the fallback here.
  "ops.alertEmail": def({
    schema: z.string().refine((v) => v === "" || isEmailAddress(v), { message: "Must be an email address" }),
    default: "",
    scopes: ["platform"],
    category: "ops",
    description:
      "Where operator alerts are emailed; empty falls back to ALERT_EMAIL, then the bootstrap operator",
  }),
  "ops.alertWebhookUrl": def({
    schema: z.string().refine((v) => v === "" || isHttpUrl(v), { message: "Must be an http(s) URL" }),
    default: "",
    scopes: ["platform"],
    category: "ops",
    description: "ntfy topic URL, Slack incoming webhook or generic JSON endpoint for operator alerts",
    secret: true,
  }),
  "ops.alertWebhookFormat": def({
    schema: z.enum(["ntfy", "slack", "generic"]),
    default: "ntfy",
    scopes: ["platform"],
    category: "ops",
    description: "Body shape sent to the alert webhook",
  }),
  "ops.alertEmailMinSeverity": def({
    schema: z.enum(["info", "warning", "critical"]),
    default: "warning",
    scopes: ["platform"],
    category: "ops",
    description: "Lowest severity emailed to the operator",
  }),
  "ops.alertWebhookMinSeverity": def({
    schema: z.enum(["info", "warning", "critical"]),
    default: "info",
    scopes: ["platform"],
    category: "ops",
    description: "Lowest severity posted to the alert webhook",
  }),
  "ops.alertRepeatMinutes": def({
    schema: z.number().int().min(1).max(10080),
    default: 60,
    scopes: ["platform"],
    category: "ops",
    description:
      "Minutes before an unresolved alert is sent again; when set, it replaces every kind's own window",
  }),
  "ops.alertMaxPerHour": def({
    schema: z.number().int().min(1).max(1000),
    default: 30,
    scopes: ["platform"],
    category: "ops",
    description: "Alerts sent per audience per hour before the rest are suppressed behind one storm notice",
  }),
  "ops.diskWarnPercent": def({
    schema: z.number().int().min(10).max(99),
    default: 80,
    scopes: ["platform"],
    category: "ops",
    description: "Disk use at which a warning is raised",
  }),
  "ops.diskCriticalPercent": def({
    schema: z.number().int().min(11).max(100),
    default: 90,
    scopes: ["platform"],
    category: "ops",
    description: "Disk use at which a critical alert is raised",
  }),
  "ops.providerErrorRateWarn": def({
    schema: z.number().min(0.05).max(1),
    default: 0.25,
    scopes: ["platform"],
    category: "ops",
    description:
      "Share of a provider's calls that failed in ten minutes, at least ten calls, that raises a warning",
  }),
  "ops.backupMaxAgeHours": def({
    schema: z.number().int().min(1).max(720),
    default: 26,
    scopes: ["platform"],
    category: "ops",
    description: "Hours without a successful backup before it is reported missing",
  }),
  // Notifications to a tenant's own people (spec 07: warn before a budget is gone, never silent).
  "notifications.recipients": def({
    schema: z.array(z.string().refine(isEmailAddress, { message: "Must be an email address" })).max(20),
    default: [],
    scopes: ["platform", "tenant"],
    category: "notifications",
    description: "Who receives this tenant's notices; empty means every admin of the tenant",
  }),
  "notifications.budgetWarnings": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "notifications",
    description: "Email the tenant's admins when a budget passes its warning threshold",
  }),
  "notifications.abuseLimits": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "notifications",
    since: "2026.10",
    description: "Email the tenant's admins when an interview link hits an abuse limit",
  }),
  // Analysis
  "analysis.weightsPreset": def({
    schema: z.enum(["balanced", "quick_wins", "strategic", "custom"]),
    default: "balanced",
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Ranking preset for opportunity factors",
  }),
  "analysis.weights": def({
    schema: z.record(z.string(), z.number().min(0).max(5)),
    default: {
      expected_impact: 1,
      affected_employees: 1,
      frequency: 1,
      implementation_complexity: 1,
      data_availability: 1,
      risk: 1,
      ai_suitability: 1,
    },
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Custom factor weights, used when the preset is custom",
  }),
  "analysis.similarityThreshold": def({
    schema: z.number().min(0.3).max(0.99),
    default: 0.72,
    scopes: ["platform", "tenant"],
    category: "analysis",
    description: "Cosine similarity at which facts join a cluster",
  }),
  "analysis.reportSections": def({
    schema: z.array(
      z.enum([
        "executive_summary",
        "participation",
        "work_map",
        "department_comparison",
        "opportunities",
        "quick_wins_vs_strategic",
        "not_ai",
        "next_steps",
      ]),
    ),
    default: [
      "executive_summary",
      "participation",
      "work_map",
      "department_comparison",
      "opportunities",
      "quick_wins_vs_strategic",
      "not_ai",
      "next_steps",
    ],
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Sections included in the organization report",
  }),
  "analysis.preliminaryVisibleToMembers": def({
    schema: z.boolean(),
    default: false,
    scopes: ["platform", "tenant"],
    category: "analysis",
    description: "Members may see results before the completion threshold",
  }),
  "analysis.departmentComparison": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Compare departments when each has at least k participants",
  }),
  "analysis.language": def({
    schema: z.string().min(2).max(5),
    default: "en",
    scopes: ["platform", "tenant", "campaign"],
    category: "analysis",
    description: "Language of the report",
  }),
  // Requirements interview (ADM-REQ). Cadence, finding types and push-back are template fields.
  "requirements.aggressivenessTechnical": def({
    schema: z.enum(["template", "gentle", "standard", "strict"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Issue-detection aggressiveness on the technical path (template = the template's own value)",
  }),
  "requirements.aggressivenessNontechnical": def({
    schema: z.enum(["template", "gentle", "standard", "strict"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description:
      "Issue-detection aggressiveness on the nontechnical path (template = the template's own value)",
  }),
  "requirements.mvpChallenge": def({
    schema: z.enum(["template", "mandatory", "optional", "off"]),
    default: "template",
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "MVP challenge before finalizing: mandatory, optional (the user may end it early), or off",
  }),
  "requirements.specSections": def({
    schema: z.array(
      z.enum([
        "overview",
        "users",
        "stories",
        "functional",
        "rules",
        "technical",
        "data",
        "integrations",
        "security",
        "nfr",
        "admin",
        "mvp",
        "future",
        "phases",
        "open_questions",
        "diagrams",
      ]),
    ),
    default: [
      "overview",
      "users",
      "stories",
      "functional",
      "rules",
      "technical",
      "data",
      "integrations",
      "security",
      "nfr",
      "admin",
      "mvp",
      "future",
      "phases",
      "open_questions",
      "diagrams",
    ],
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Specification sections, in order",
  }),
  "requirements.diagramTypes": def({
    schema: z.array(z.enum(["context", "containers", "sequence", "state", "entity"])),
    default: ["context", "containers", "sequence", "state", "entity"],
    scopes: ["platform", "tenant", "template"],
    category: "requirements",
    description: "Diagram types generated into the specification",
  }),
  // Exports
  "exports.bundleFormat": def({
    schema: z.enum(["claude_code", "codex", "generic"]),
    default: "claude_code",
    scopes: ["platform", "tenant", "template"],
    category: "exports",
    description: "Agent bundle flavor",
  }),
  // PDF export (D-210): name and colour come from branding; there is no logo upload.
  "exports.pdfPageSize": def({
    schema: z.enum(["A4", "Letter"]),
    default: "A4",
    scopes: ["platform", "tenant"],
    category: "exports",
    description: "Page size of PDF exports",
    since: "2026.10",
  }),
  "exports.pdfCoverPage": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "exports",
    description: "Start PDF exports with a cover page",
    since: "2026.10",
  }),
  "exports.pdfFooterText": def({
    schema: z.string().max(120),
    default: "",
    scopes: ["platform", "tenant"],
    category: "exports",
    description: "Text added to the footer of every PDF page",
    since: "2026.10",
  }),
  // Added in 2026.10: notifications to the tenant's admins, the voice switch per template, the
  // tenant ceilings, and the onboarding card. Each carries `since` so the "what changed" panel
  // can say so (D-180).
  "notifications.campaignThreshold": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "notifications",
    description: "Email the tenant's admins when a campaign reaches its completion threshold",
    since: "2026.10",
  }),
  "notifications.analysisReady": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "notifications",
    description: "Email the tenant's admins when an analysis has finished",
    since: "2026.10",
  }),
  "notifications.specReady": def({
    schema: z.boolean(),
    default: true,
    scopes: ["platform", "tenant"],
    category: "notifications",
    description: "Email the tenant's admins when a specification version has been generated",
    since: "2026.10",
  }),
  "branding.language": def({
    schema: z.enum(["en", "fi"]),
    default: "en",
    scopes: ["platform", "tenant"],
    category: "branding",
    description: "Language of the emails sent to the tenant's admins",
    since: "2026.10",
  }),
  "voice.enabled": def({
    schema: z.boolean(),
    default: true,
    scopes: ["tenant", "template"],
    category: "voice",
    description: "Voice answers for this template; a template cannot turn on what the tenant has turned off",
    since: "2026.10",
  }),
  "ui.onboardingDismissed": def({
    schema: z.boolean(),
    default: false,
    scopes: ["tenant"],
    category: "ui",
    description: "The getting-started card on the dashboard was dismissed",
    since: "2026.10",
  }),
  // Tenant ceilings (D-188). The operator sets them; 0 means no ceiling. Campaign and session
  // creation enforce the first two; all four feed the utilisation view and the 80 and 100 percent
  // alerts.
  "ceiling.maxActiveCampaigns": def({
    schema: z.number().int().min(0).max(100000),
    default: 20,
    scopes: ["platform", "tenant"],
    category: "ceiling",
    description: "Most campaigns a tenant may have open or in draft at once; 0 is no ceiling",
    operatorOnly: true,
    since: "2026.10",
  }),
  "ceiling.maxSessionsPerMonth": def({
    schema: z.number().int().min(0).max(10000000),
    default: 1000,
    scopes: ["platform", "tenant"],
    category: "ceiling",
    description: "Most interviews a tenant may start in a calendar month; 0 is no ceiling",
    operatorOnly: true,
    since: "2026.10",
  }),
  "ceiling.storageBytes": def({
    schema: z.number().int().min(0),
    default: 5 * 1024 * 1024 * 1024,
    scopes: ["platform", "tenant"],
    category: "ceiling",
    description: "Bytes of files and recordings a tenant may keep; 0 is no ceiling",
    operatorOnly: true,
    since: "2026.10",
  }),
  "ceiling.voiceMinutes": def({
    schema: z.number().int().min(0).max(10000000),
    default: 600,
    scopes: ["platform", "tenant"],
    category: "ceiling",
    description: "Minutes of voice a tenant may use in a calendar month; 0 is no ceiling",
    operatorOnly: true,
    since: "2026.10",
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]["schema"]>;

export function settingDefault<K extends SettingKey>(key: K): SettingValue<K> {
  return SETTINGS[key].default as SettingValue<K>;
}

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return SETTINGS[key].schema.parse(value) as SettingValue<K>;
}

export function settingKeysForScope(scope: SettingScope): SettingKey[] {
  return (Object.keys(SETTINGS) as SettingKey[]).filter((k) => SETTINGS[k].scopes.includes(scope));
}

export function isSecretSetting(key: SettingKey): boolean {
  return SETTINGS[key].secret === true;
}

export function isOperatorOnlySetting(key: SettingKey): boolean {
  return (SETTINGS[key] as SettingDef).operatorOnly === true;
}

export function secretSettingKeys(): SettingKey[] {
  return (Object.keys(SETTINGS) as SettingKey[]).filter(isSecretSetting);
}

/** Replaces any secret that holds a value with the sentinel, so a map may safely leave the API. */
export function maskSecretSettings(
  values: Partial<Record<SettingKey, unknown>>,
): Partial<Record<SettingKey, unknown>> {
  const out: Partial<Record<SettingKey, unknown>> = { ...values };
  for (const key of secretSettingKeys()) {
    if (!(key in out)) continue;
    const v = out[key];
    out[key] = typeof v === "string" && v.length > 0 ? SECRET_SENTINEL : v;
  }
  return out;
}
