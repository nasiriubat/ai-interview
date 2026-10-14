/**
 * The participant welcome (D-460, D-461), apart from the settings catalog so the web app's string
 * tables can import the defaults without pulling zod into every page: zod probes for \`eval\` when
 * it builds schemas, which the page's Content-Security-Policy reports.
 */

/**
 * What a participant reads on the arrival screen and in the side panel (D-460). The template's
 * `objective` is written for the interviewer ("Understand how this person's work is actually
 * performed..."), so it is never shown to the person being interviewed; this is. A campaign may
 * write its own in `campaign.welcomeText`; otherwise the default for the template's kind and
 * language is used. The wording promises only what the product does: one question at a time,
 * own words, pause and return, a summary at the end.
 */
export const DEFAULT_WELCOME_TEXT = {
  discovery: {
    en: "Thank you for taking part. This is a conversation about how your work actually goes: what fills your day, what slows you down and what already works well. There are no right or wrong answers. Answer in your own words, one question at a time, and pause whenever you need to; you can come back to where you left off.",
    fi: "Kiitos, että osallistut. Tämä on keskustelu siitä, miten työsi oikeasti sujuu: mihin päiväsi kuluu, mikä hidastaa ja mikä toimii jo hyvin. Oikeita tai vääriä vastauksia ei ole. Vastaa omin sanoin, kysymys kerrallaan, ja pidä tauko aina kun tarvitset; voit jatkaa siitä, mihin jäit.",
  },
  requirements: {
    en: "Thank you for making the time. This conversation turns your idea into a written specification. We will go through the problem, who it is for and how it should work, one question at a time. If you are unsure about something, say so and a sensible default is suggested. At the end, what was understood is read back to you so you can correct it.",
    fi: "Kiitos, että järjestit aikaa. Tässä keskustelussa ideastasi tehdään kirjallinen määrittely. Käymme läpi ongelman, kenelle ratkaisu on ja miten sen pitäisi toimia, kysymys kerrallaan. Jos jokin on epäselvää, sano se, niin saat järkevän oletusehdotuksen. Lopuksi ymmärretty luetaan sinulle, jotta voit korjata sen.",
  },
} as const;

export type WelcomeKind = keyof typeof DEFAULT_WELCOME_TEXT;

/** The template key of the shipped requirements interview; tenant copies keep it (D-460). */
const REQUIREMENTS_KEY = "requirements_discovery";

/**
 * Which default welcome a template gets: a requirements interview (the shipped key, or any template
 * with issue detection switched on, which only requirements interviews use) or a discovery one.
 */
export function welcomeKindOf(template: { key?: string | null; issueDetection?: unknown }): WelcomeKind {
  if (template.key === REQUIREMENTS_KEY) return "requirements";
  const issues = template.issueDetection as { enabled?: unknown } | null | undefined;
  return issues && typeof issues === "object" && issues.enabled === true ? "requirements" : "discovery";
}

/** The default welcome for a kind and an interview language; any language but Finnish gets English. */
export function defaultWelcomeText(kind: WelcomeKind, language: string | null | undefined): string {
  const texts = DEFAULT_WELCOME_TEXT[kind];
  return language?.toLowerCase().startsWith("fi") ? texts.fi : texts.en;
}

/**
 * The welcome a participant sees: the campaign's own text when one was saved and is not blank,
 * else the default for the template's kind and language. Never the template objective.
 */
export function participantWelcome(
  saved: unknown,
  template: { key?: string | null; issueDetection?: unknown; language?: string | null },
): string {
  if (typeof saved === "string" && saved.trim() !== "") return saved.trim();
  return defaultWelcomeText(welcomeKindOf(template), template.language);
}
