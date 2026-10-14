import { participantSession, participantSessionLive } from "./fixtures";

/*
 * Variants of the participant's session for the visual review and the layout assertions (D-380).
 * The fake API picks one by a word in the participant token: "long", "ended", "paused", "live".
 */
const NOW = "2026-10-14T09:30:00.000Z";
const EARLIER = "2026-10-10T08:00:00.000Z";

export const LONG_ANSWER =
  "Honestly it depends on the shift. On a night shift I mostly chase down handover notes that were written in three different places, and then I retype the same medication changes into the ward system, the paper chart and the whiteboard because nobody trusts only one of them. Supercalifragilisticexpialidocious_handover_documentation_requirement_identifier_0123456789 is what the field is called.";
const LONG_QUESTION =
  "Thank you, that is really helpful and it is clear that a lot of your time goes into keeping several records in step. When one of those copies turns out to be wrong, what happens next, who finds out, and how long does it usually take before somebody corrects it? Take your time, there is no right answer.";

const long = {
  ...participantSession,
  progress: {
    areas: [
      { key: "role", name: "Your role and responsibilities on the ward", status: "covered" },
      { key: "daily_work", name: "A normal day, from the start of the shift to handover", status: "partial" },
      { key: "tools", name: "Tools, systems and paper records you rely on", status: "untouched" },
      { key: "people", name: "People you depend on", status: "skipped" },
      { key: "wishes", name: "What you would change first", status: "untouched" },
    ],
  },
  messages: [
    ...participantSession.messages.slice(0, 2),
    { id: "m3", seq: 3, role: "assistant", modality: "text", content: LONG_QUESTION, createdAt: EARLIER },
    { id: "m4", seq: 4, role: "user", modality: "voice", content: LONG_ANSWER, createdAt: EARLIER },
    {
      id: "m5",
      seq: 5,
      role: "assistant",
      modality: "text",
      content: "Which of these takes most of your time? Pick the closest, or describe it in your own words.",
      widget: {
        type: "single_choice",
        options: [
          { key: "doc", label: "Documentation that has to be written twice because two systems do not talk" },
          { key: "hand", label: "Handover" },
          { key: "meds", label: "Medication rounds" },
        ],
      },
      createdAt: NOW,
    },
  ],
};

const ended = {
  ...participantSession,
  status: "completed",
  progress: { areas: participantSession.progress.areas.map((a) => ({ ...a, status: "covered" })) },
  messages: participantSession.messages.slice(0, 2),
};

const paused = { ...participantSession, status: "paused" };

/** The session a participant token stands for. */
export function participantVariant(auth: string): unknown {
  if (auth.includes("long")) return long;
  if (auth.includes("ended")) return ended;
  if (auth.includes("paused")) return paused;
  if (auth.includes("live")) return participantSessionLive;
  return participantSession;
}
