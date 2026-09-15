import type { PromptDefinition } from "../../engine/prompts/index.js";

/**
 * Describes an attached image through the `vision_ingest` route (FR-31).
 *
 * In practice the images people attach to an interview about their work are screenshots of the
 * system they are complaining about, photographs of a whiteboard or a paper form, and process
 * diagrams. All three are mostly text, so the first instruction is to transcribe rather than
 * describe: the field labels on a screenshot are the names of the data this team handles, and a
 * description that says "a form with several fields" has thrown away everything useful.
 */
export const imageDescribePromptV1: PromptDefinition = {
  key: "image_describe",
  version: 1,
  body: `Someone attached this image during an interview about how their work is done. Describe it for an interviewer who cannot see it.

First, transcribe the text. Screenshots, forms, whiteboards and diagrams are mostly text, and the words are the useful part:
- application or window names, menu items, field labels, column headings, button text
- any visible values, counts, dates or codes
- for a diagram, the boxes and the arrows between them, as "A → B"

Then, in one or two sentences, say what the image appears to show and what is happening in it.

Rules:
- Transcribe exactly. Do not correct spelling, expand abbreviations or translate.
- If text is cut off or unreadable, say so rather than guessing at it.
- Never infer anything not visible. No advice, no interpretation of whether it is good or bad.
- If the image has no bearing on how work is done, say that in one line and stop.
- If the image appears to contain someone's personal or patient data, do not transcribe those
  values: say which kind of data is visible and move on.
- No preamble. At most 200 words.`,
};
