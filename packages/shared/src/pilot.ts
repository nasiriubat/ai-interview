import { z } from "zod";
import { isEmailAddress } from "./settings.js";

/**
 * The public "Request a pilot" form (`/pilot`). One contract for the browser's checks and the
 * API's, so a value the page accepts is one the API accepts.
 *
 * Every field is length-capped: the request becomes an email to the operator, and nothing a
 * stranger types should make that email large. The honeypot (`website`) and the ticket are not
 * the visitor's data; they are how the API tells a person from a script (see the API's
 * `modules/pilot`).
 */

export const PILOT_COMPANY_SIZES = ["1-49", "50-249", "250-999", "1000+"] as const;
export type PilotCompanySize = (typeof PILOT_COMPANY_SIZES)[number];

export const PILOT_INTERESTS = ["discovery", "requirements", "both", "unsure"] as const;
export type PilotInterest = (typeof PILOT_INTERESTS)[number];

/** How many people the pilot would interview; optional on the form. */
export const PILOT_PARTICIPANTS = ["1-10", "11-30", "31-100", "100+", "unsure"] as const;
export type PilotParticipants = (typeof PILOT_PARTICIPANTS)[number];

export const PILOT_LIMITS = {
  name: 120,
  email: 254,
  company: 160,
  role: 120,
  message: 2000,
  /** The honeypot: a person never fills it, so anything is enough to tell. */
  website: 200,
  ticket: 200,
} as const;

/** CR, LF and the other C0/C1 controls, which have no place in a one-line value. */
const CONTROL = /\p{Cc}/u;

/** A required one-line value: trimmed, non-empty, capped, and free of control characters. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !CONTROL.test(v), { message: "Must be a single line" });

export const PilotRequestSchema = z.object({
  name: line(PILOT_LIMITS.name),
  email: z
    .string()
    .trim()
    .min(1)
    .max(PILOT_LIMITS.email)
    .refine((v) => isEmailAddress(v) && !CONTROL.test(v), { message: "Must be an email address" }),
  company: line(PILOT_LIMITS.company),
  role: line(PILOT_LIMITS.role),
  companySize: z.enum(PILOT_COMPANY_SIZES),
  interest: z.enum(PILOT_INTERESTS),
  participants: z.enum(PILOT_PARTICIPANTS).optional(),
  message: z.string().trim().max(PILOT_LIMITS.message).optional(),
  /** Consent to be contacted about the pilot. Required, and only `true` is consent. */
  consent: z.literal(true),
  /** The page's language, so the reply can be written in it. */
  locale: z.enum(["en", "fi"]).optional(),
  /** Honeypot: hidden from people, filled by form-filling scripts. */
  website: z.string().max(PILOT_LIMITS.website).optional(),
  /** The signed time the form was shown, from `GET /public/pilot-requests/ticket`. */
  ticket: z.string().max(PILOT_LIMITS.ticket).optional(),
});
export type PilotRequest = z.infer<typeof PilotRequestSchema>;

/** What the ticket route answers. */
export const PilotTicketSchema = z.object({ ticket: z.string() });

/**
 * The fields a person fills in, as the browser checks them: the same rules without the hidden
 * ones, so the form's errors name only what the person can see.
 */
export const PilotFormSchema = PilotRequestSchema.omit({ website: true, ticket: true, locale: true });
