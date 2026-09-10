import { z } from "zod";

/**
 * Widgets render below an interviewer message. The participant may always ignore a
 * widget and answer in chat. Every choice widget carries an implicit "Other" entry that
 * accepts typed or spoken input, so options never need to include it.
 */
const OptionSchema = z.object({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(120),
  detail: z.string().max(400).optional(), // expandable explanation
});
export type WidgetOption = z.infer<typeof OptionSchema>;

export const WidgetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single_choice"), options: z.array(OptionSchema).min(2).max(8) }),
  z.object({
    type: z.literal("multi_choice"),
    options: z.array(OptionSchema).min(2).max(10),
    max: z.number().int().min(1).max(10).optional(),
  }),
  z.object({
    type: z.literal("scale"),
    min: z.literal(1),
    max: z.literal(5),
    minLabel: z.string().max(40),
    maxLabel: z.string().max(40),
  }),
  z.object({ type: z.literal("ranking"), options: z.array(OptionSchema).min(2).max(5) }),
  z.object({
    type: z.literal("yes_no"),
    followUpOnYes: z.string().max(200).optional(),
    followUpOnNo: z.string().max(200).optional(),
  }),
]);
export type Widget = z.infer<typeof WidgetSchema>;
export const WIDGET_TYPES = ["single_choice", "multi_choice", "scale", "ranking", "yes_no"] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

/** What the participant did with a widget. `other` carries free text or a transcript. */
export const WidgetResponseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single_choice"), key: z.string().optional(), other: z.string().optional() }),
  z.object({ type: z.literal("multi_choice"), keys: z.array(z.string()), other: z.string().optional() }),
  z.object({ type: z.literal("scale"), value: z.number().int().min(1).max(5) }),
  z.object({ type: z.literal("ranking"), keys: z.array(z.string()) }),
  z.object({ type: z.literal("yes_no"), value: z.boolean(), other: z.string().optional() }),
]);
export type WidgetResponse = z.infer<typeof WidgetResponseSchema>;

/** Renders a widget response as the text the engine and transcript use. */
export function widgetResponseToText(widget: Widget, response: WidgetResponse): string {
  const label = (key: string): string => {
    const opts = "options" in widget ? widget.options : [];
    return opts.find((o) => o.key === key)?.label ?? key;
  };
  switch (response.type) {
    case "single_choice":
      return [response.key ? label(response.key) : undefined, response.other].filter(Boolean).join(": ");
    case "multi_choice":
      return [...response.keys.map(label), response.other].filter(Boolean).join(", ");
    case "scale":
      return `${response.value} of 5`;
    case "ranking":
      return response.keys.map((k, i) => `${i + 1}. ${label(k)}`).join("; ");
    case "yes_no":
      return [response.value ? "Yes" : "No", response.other].filter(Boolean).join(". ");
  }
}
