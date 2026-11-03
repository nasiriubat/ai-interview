import type { TurnAnswer } from "@aidp/ai";
import { TurnControlSchema, WidgetResponseSchema } from "@aidp/shared";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";

/**
 * The body of `POST /p/session/turns` and `POST /requirements/:id/turns` (contract 16).
 *
 * `control` is a participant operation on the interview (skip an area, come back to one, finish)
 * and is mutually exclusive with an answer: a control is never a message (D-170).
 */
export const TurnBody = z
  .object({
    content: z.string().max(8000).default(""),
    modality: z.enum(["text", "widget", "voice", "dictated"]).default("text"),
    widgetResponse: WidgetResponseSchema.optional(),
    control: TurnControlSchema.optional(),
  })
  .refine((b) => !b.control || (b.content.trim() === "" && !b.widgetResponse), {
    message: "A control cannot be combined with an answer",
    path: ["control"],
  });
export type TurnBody = z.infer<typeof TurnBody>;

/**
 * Parses a turn body that arrives unvalidated (the first turn has no body at all, so the route
 * schema cannot do it) and answers a 400 rather than letting a ZodError become a 500.
 */
export function parseTurnBody(raw: unknown): TurnBody {
  const parsed = TurnBody.safeParse(raw ?? {});
  if (!parsed.success)
    throw new AppError("validation", parsed.error.issues[0]?.message ?? "Invalid turn", {
      issues: parsed.error.issues,
    });
  return parsed.data;
}

/** The engine's input for a parsed body: a control, an answer, or nothing (the first turn). */
export function answerFromBody(body: TurnBody): TurnAnswer | undefined {
  if (body.control) return { control: body.control };
  if (body.content.trim() || body.widgetResponse)
    return {
      content: body.content,
      modality: body.modality,
      ...(body.widgetResponse ? { widgetResponse: body.widgetResponse } : {}),
    };
  return undefined;
}
