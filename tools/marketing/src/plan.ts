/**
 * The pure half of the capture script: configuration from the environment, the mail parsing for
 * sign-in links and codes, and the shot list. No browser and no network, so it is tested.
 */

export interface CaptureConfig {
  /** Where people open the web app, e.g. http://localhost:3000. */
  base: string;
  /** Mailpit's web address (its API lives under /api/v1). */
  mailpit: string;
  /** A tenant admin of the stack; the sign-in link is read from Mailpit. */
  adminEmail: string;
  /** Output directory for the PNG files and index.md. */
  out: string;
  /** Campaign to photograph; the first in the list when empty. */
  campaignId: string;
  /** Requirements interview to photograph; the first in the list when empty. */
  requirementsId: string;
  /** Run a short real participant interview for the chat, voice and summary shots (costs model calls). */
  interview: boolean;
  /** A WAV file for Chromium's fake microphone, for the recorded-voice shot. */
  micWav: string;
  /** Only shots whose number or name contains one of these (comma separated); all when empty. */
  only: string[];
}

export function configFrom(env: Record<string, string | undefined>): CaptureConfig {
  const adminEmail = env.ADMIN_EMAIL?.trim() ?? "";
  if (!adminEmail) throw new Error("ADMIN_EMAIL is required: a tenant admin of the stack you photograph");
  return {
    base: (env.BASE ?? "http://localhost:3000").replace(/\/+$/, ""),
    mailpit: (env.MAILPIT ?? "http://localhost:8025").replace(/\/+$/, ""),
    adminEmail,
    out: env.OUT ?? "marketing/screenshots",
    campaignId: env.CAMPAIGN ?? "",
    requirementsId: env.REQUIREMENTS ?? "",
    interview: env.INTERVIEW === "1",
    micWav: env.MIC_WAV ?? "",
    only: (env.ONLY ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** The first link in a mail body that contains `contains`, with HTML entities undone. */
export function linkIn(body: string, contains: string): string | null {
  for (const m of body.matchAll(/https?:\/\/[^\s"'<>)]+/g)) {
    const url = m[0].replace(/&amp;/g, "&");
    if (url.includes(contains)) return url;
  }
  return null;
}

/** The six-digit code in a verification mail. */
export function codeIn(body: string): string | null {
  return /\b(\d{6})\b/.exec(body)?.[1] ?? null;
}

export type Viewport = "desktop" | "phone";

export interface Shot {
  /** Two-digit order, stable across runs so index.md and the voice-over can refer to it. */
  n: string;
  name: string;
  viewport: Viewport;
  locale: "en" | "fi";
  theme: "light" | "dark";
  /** What it shows and where it is best used, for index.md. */
  shows: string;
  use: string;
}

const s = (
  n: number,
  name: string,
  shows: string,
  use: string,
  o: Partial<Pick<Shot, "viewport" | "locale" | "theme">> = {},
): Shot => ({
  n: String(n).padStart(2, "0"),
  name,
  viewport: o.viewport ?? "desktop",
  locale: o.locale ?? "en",
  theme: o.theme ?? "light",
  shows,
  use,
});

/** Every shot, in the order of the story the material tells. */
export const SHOTS: readonly Shot[] = [
  s(
    1,
    "landing-hero",
    "Landing page, first screen: what the product does in one sentence.",
    "Opening frame, website header, slide 1.",
  ),
  s(
    2,
    "landing-chatbot",
    "Landing page: the comparison with just asking a chatbot.",
    "The 'why not ChatGPT' moment in a pitch.",
  ),
  s(
    3,
    "landing-trust",
    "Landing page: privacy, anonymity, hosting and cost controls.",
    "Security and procurement conversations.",
  ),
  s(
    4,
    "admin-overview",
    "Admin overview: spend, open campaigns, interviews, funnel.",
    "Shows the operator's day-to-day view.",
  ),
  s(
    5,
    "campaign",
    "A discovery campaign: share link, QR code, progress to the threshold.",
    "How a round of interviews is run.",
  ),
  s(
    6,
    "participant-arrival",
    "What a participant sees first: the campaign's welcome, length, what is kept.",
    "Participant experience, trust.",
  ),
  s(7, "participant-arrival-phone", "The same arrival on a phone.", "Mobile-first claim; social posts.", {
    viewport: "phone",
  }),
  s(
    8,
    "participant-chat",
    "The interview: one question at a time, topics on the side.",
    "Core product moment.",
  ),
  s(9, "participant-chat-phone", "The interview on a phone.", "Mobile participant experience.", {
    viewport: "phone",
  }),
  s(
    10,
    "participant-voice-phone",
    "A dictated answer: the recording turned into text in the box, to check before sending.",
    "Speaking instead of typing.",
    { viewport: "phone" },
  ),
  s(
    11,
    "participant-summary",
    "The end: an editable summary and what was noted.",
    "Participant keeps control.",
  ),
  s(12, "participant-summary-phone", "The end on a phone.", "Mobile.", { viewport: "phone" }),
  s(
    13,
    "results-overview",
    "Results: interviews, groups, hours described, solution classes.",
    "The payoff for the buyer.",
  ),
  s(
    14,
    "results-opportunities",
    "Ranked opportunities with people, minutes per week and score.",
    "Prioritisation story.",
  ),
  s(
    15,
    "opportunity-detail",
    "One opportunity: seven factor scores, evidence, where it came from.",
    "Explainability; 'every number has a source'.",
  ),
  s(
    16,
    "results-departments",
    "Department comparison, shown only for groups of at least k.",
    "Anonymity by design.",
  ),
  s(
    17,
    "report",
    "The report: method, ranked opportunities, where AI is not the answer.",
    "What leadership receives.",
  ),
  s(18, "report-pdf", "The first page of the exported PDF.", "Attachment-ready deliverable."),
  s(
    19,
    "requirements-workspace",
    "Requirements interview: conversation beside the live specification.",
    "Idea to specification.",
  ),
  s(
    20,
    "requirements-readback",
    "The read-back: what was understood, for the owner to confirm.",
    "Nothing is assumed silently.",
  ),
  s(
    21,
    "spec-document",
    "A generated specification version with numbered requirements.",
    "Developer hand-off.",
  ),
  s(22, "spec-compare", "Two versions compared requirement by requirement.", "Change control."),
  s(23, "spec-diagram", "Editable diagrams in the specification.", "Visual thinkers; architecture."),
  s(
    24,
    "spec-export",
    "Exports: PDF, Markdown and the agent bundle for coding agents.",
    "Hand-off to a coding agent.",
  ),
  s(
    25,
    "settings-branding",
    "Settings: the product name and logo are yours.",
    "White-label / own deployment.",
  ),
  s(26, "account", "Account page.", "Admin experience completeness."),
  s(27, "fi-landing-hero", "The landing page in Finnish.", "Finnish audiences.", { locale: "fi" }),
  s(28, "fi-participant-arrival", "Participant arrival in Finnish.", "Finnish participants.", {
    locale: "fi",
  }),
  s(29, "fi-results-overview", "Results in Finnish.", "Finnish buyers.", { locale: "fi" }),
  s(30, "dark-results-overview", "Results in the dark theme.", "Variety in a deck; dark-mode users.", {
    theme: "dark",
  }),
  s(
    31,
    "providers",
    "Providers: every model provider the tenant can use, with its kind and a connection test.",
    "Bring your own models; which vendor runs the interviews.",
  ),
  s(
    32,
    "model-assignment",
    "Model assignment: one provider for every text task in one step, then each task's model and effort.",
    "Switching provider without a migration (D-495).",
  ),
  s(
    33,
    "spend",
    "Budgets and spend: every model call booked with its cost, by task.",
    "Cost control; what a campaign really cost.",
  ),
];

export function fileName(shot: Shot): string {
  return `${shot.n}-${shot.name}.png`;
}

export function selected(shot: Shot, only: readonly string[]): boolean {
  return only.length === 0 || only.some((o) => shot.n === o.padStart(2, "0") || shot.name.includes(o));
}

/** index.md: every file, what it shows, where it is best used. */
export function indexMarkdown(shots: readonly Shot[], taken: ReadonlySet<string>, note: string): string {
  const rows = shots
    .filter((x) => taken.has(fileName(x)))
    .map(
      (x) =>
        `| [${fileName(x)}](${fileName(x)}) | ${x.viewport}, ${x.locale}, ${x.theme} | ${x.shows} | ${x.use} |`,
    );
  return [
    "# Screenshots",
    "",
    note,
    "",
    "| File | Viewport, language, theme | What it shows | Best use |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
