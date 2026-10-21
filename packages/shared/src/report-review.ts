import { z } from "zod";

/**
 * The review state of a report version (D-478). A new analysis run makes a draft; an
 * administrator marks it reviewed after checking it; an edit of its opportunities returns it to
 * draft. Every copy that leaves the admin (PDF, Markdown, print) says which it is.
 */
export const ReportReviewStatusSchema = z.enum(["draft", "reviewed"]);
export type ReportReviewStatus = z.infer<typeof ReportReviewStatusSchema>;

export const ReportReviewSchema = z.object({
  status: ReportReviewStatusSchema,
  /** The reviewer's name as it was when they reviewed (their email when they had no name). */
  reviewedBy: z.string().nullable(),
  reviewedAt: z.coerce.date().nullable(),
});
export type ReportReview = z.infer<typeof ReportReviewSchema>;

export const ReportReviewBodySchema = z.object({ status: ReportReviewStatusSchema });

const NOTICE = {
  en: {
    draft: "Draft – not yet reviewed",
    draftBody:
      "No one has checked this report yet. Figures and wording may still change before it is shared.",
    reviewed: (who: string, date: string) => `Reviewed by ${who} on ${date}`,
    watermark: "DRAFT",
  },
  fi: {
    draft: "Luonnos – ei vielä tarkistettu",
    draftBody:
      "Kukaan ei ole vielä tarkistanut tätä raporttia. Luvut ja sanamuodot voivat muuttua ennen jakamista.",
    reviewed: (who: string, date: string) => `Tarkistanut ${who} ${date}`,
    watermark: "LUONNOS",
  },
} as const;

const lang = (language: string): keyof typeof NOTICE =>
  language.toLowerCase().startsWith("fi") ? "fi" : "en";
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** The one-line status every exported copy carries: "Draft – not yet reviewed" or "Reviewed by …". */
export function reportReviewNotice(review: ReportReview, language: string): string {
  const L = NOTICE[lang(language)];
  if (review.status === "reviewed" && review.reviewedAt)
    return L.reviewed(review.reviewedBy ?? "—", isoDay(review.reviewedAt));
  return L.draft;
}

/** The diagonal mark printed across every page of a draft PDF; null once reviewed. */
export function reportReviewWatermark(review: ReportReview, language: string): string | null {
  return review.status === "reviewed" ? null : NOTICE[lang(language)].watermark;
}

/**
 * The status as a Markdown block for the top of a downloaded report. A draft says what that means;
 * a reviewed report says by whom and when.
 */
export function reportReviewMarkdown(review: ReportReview, language: string): string {
  const L = NOTICE[lang(language)];
  const head = reportReviewNotice(review, language);
  return review.status === "reviewed" && review.reviewedAt
    ? `> **${head}.**`
    : `> **${head}.** ${L.draftBody}`;
}
