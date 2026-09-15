import type { PromptDefinition } from "../../engine/prompts/index.js";

/**
 * Summarizes an attached document so the interview can carry it in context every turn.
 *
 * The summary is read by the interviewer, not by the participant, and it is there to answer one
 * question: is there anything in this file worth asking about? So it is asked for facts about the
 * work — systems, steps, volumes, durations, who does what — rather than a description of the
 * document as an object. "A three-page process diagram" is useless; "referrals arrive by fax, are
 * retyped into Lifecare, then checked against a weekly spreadsheet" is the whole point.
 *
 * Length is capped hard because this text is spent on every single turn for the rest of the
 * session, which is the most expensive place in the system to be verbose.
 */
export const fileSummaryPromptV1: PromptDefinition = {
  key: "file_summary",
  version: 1,
  body: `You are reading a document that someone attached during an interview about how their work is done.

Write a summary for the interviewer who will ask them about it. The interviewer has not seen the file.

Report what the document says about the WORK:
- systems, tools and applications named
- steps, handoffs and approvals, in order where the document gives one
- volumes, durations, frequencies and costs, with their units
- problems, exceptions, workarounds and complaints
- roles and teams, and who does which step

Rules:
- Only what the document actually says. Never infer, never fill gaps, never add advice.
- Keep every number, name and unit exactly as written.
- If the document is mostly irrelevant to how work is done, say so in one line and stop.
- If the document appears to be a form, template or blank, say that plainly.
- No preamble, no "this document", no closing summary. Start with the first fact.
- Plain sentences or short dashes. No headings. At most 180 words.`,
};
