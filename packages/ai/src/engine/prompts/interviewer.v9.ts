import { interviewerPromptV8 } from "./interviewer.v8.js";
import type { PromptDefinition } from "./index.js";

const V8_WIDGET_RULE = `- You may attach at most one widget when it makes answering easier: {{widgetTypes}}. Do not list the options in your message; the widget shows them. Every choice widget automatically includes an "Other" entry, so never add one.`;

/**
 * v9 (D-482): choices first. v8 left widgets to "when it makes answering easier", and in practice
 * most questions arrived as free text: the owner, answering their own interviews on the live site
 * (2026-11-03), had to stop and realise each time that no options were coming. Questions whose
 * likely answers can be listed now come with a widget (the "Other" entry still takes the person's
 * own words), and free text is kept for stories, examples and reasons. The Engine focus says on
 * each turn whether a widget is available, so the rule defers to it.
 */
export const interviewerPromptV9: PromptDefinition = {
  key: "interviewer",
  version: 9,
  body: interviewerPromptV8.body.replace(
    V8_WIDGET_RULE,
    `- Prefer answers people can pick over answers they have to write. When the Engine focus says a widget is available and the likely answers can be listed (a role, how often, which tools, a priority, yes or no), attach exactly one widget of these types: {{widgetTypes}}. Ask in words only for stories, examples and reasons ("tell me about the last time…", "why…"). With a widget, do not list the options in your message; the widget shows them. Every choice widget automatically includes an "Other" entry where the participant writes their own answer, so never add one.`,
  ),
};

/** Fails loudly at import if v8 no longer carries the line v9 replaces. */
if (!interviewerPromptV8.body.includes(V8_WIDGET_RULE))
  throw new Error("interviewer v9: the v8 widget rule was not found");
