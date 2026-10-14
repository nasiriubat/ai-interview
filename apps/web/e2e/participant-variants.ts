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

/**
 * A long interview in which the participant answered by recording eight times (D-423): twelve and
 * more turns, each spoken answer with its own stored clip. This is the session the owner reported,
 * where the clips stacked above the composer until the conversation was pushed out of view.
 */
const VOICE_ANSWERS = [
  "I start the shift by reading the handover notes, mostly from the paper chart.",
  "Then I check medication changes and retype them into the ward system.",
  "If two records disagree I ask the nurse who wrote the earlier one.",
  "It usually takes until the afternoon before somebody corrects the whiteboard.",
  "The worst part is that nobody trusts only one of the three places.",
  "A single shared note per patient would save me about forty minutes a shift.",
  "I would also want a way to flag a change so the next shift sees it first.",
  "That is about it, apart from the night shift, which is a different story.",
];
const QUESTIONS = [
  "How does a normal shift start for you?",
  "What do you do with the medication changes?",
  "What happens when two records disagree?",
  "How long does a correction take?",
  "What bothers you most about that?",
  "What would help the most?",
  "Is there anything you would want to be told about?",
  "Anything else you would like to add?",
];
const base = Date.parse("2026-10-14T09:00:00.000Z");
const voiceMessages = QUESTIONS.flatMap((q, i) => [
  {
    id: `vq${String(i)}`,
    seq: 2 * i + 1,
    role: "assistant",
    modality: "text",
    content: q,
    createdAt: new Date(base + i * 60_000).toISOString(),
  },
  {
    id: `va${String(i)}`,
    seq: 2 * i + 2,
    role: "user",
    modality: "voice",
    content: VOICE_ANSWERS[i] ?? "",
    createdAt: new Date(base + i * 60_000 + 30_000).toISOString(),
  },
]);
const voiceClips = QUESTIONS.map((_, i) => ({
  id: `clip${String(i)}`,
  kind: "audio",
  filename: "recording.wav",
  mime: "audio/wav",
  sizeBytes: 48_000,
  status: "ready",
  durationMs: 6000 + i * 2300,
  createdAt: new Date(base + i * 60_000 + 29_000).toISOString(),
}));

const voices = {
  ...participantSession,
  modePreference: "voice",
  progress: {
    areas: [
      { key: "role", name: "Your role", status: "covered" },
      { key: "daily_work", name: "A normal day", status: "covered" },
      { key: "tools", name: "Tools and systems", status: "partial" },
      { key: "people", name: "People you depend on", status: "untouched" },
    ],
  },
  messages: [
    ...voiceMessages,
    {
      id: "vq-last",
      seq: 99,
      role: "assistant",
      modality: "text",
      content: "Thank you. Which tool do you open first when something looks wrong?",
      createdAt: new Date(base + 9 * 60_000).toISOString(),
    },
  ],
  attachments: voiceClips,
  about: { name: "Ward round, Q4", purpose: "We want to understand how work really happens on your ward." },
};

/** The attachments a session starts with (the fake API serves the same list on the poll). */
export function participantAttachments(auth: string): unknown[] {
  return auth.includes("voices") ? voiceClips : [];
}

const ended = {
  ...participantSession,
  status: "completed",
  progress: { areas: participantSession.progress.areas.map((a) => ({ ...a, status: "covered" })) },
  messages: participantSession.messages.slice(0, 2),
};

const paused = { ...participantSession, status: "paused" };

/** The session a participant token stands for. */
export function participantVariant(auth: string): unknown {
  if (auth.includes("voices")) return voices;
  if (auth.includes("long")) return long;
  if (auth.includes("ended")) return ended;
  if (auth.includes("paused")) return paused;
  if (auth.includes("live")) return participantSessionLive;
  return participantSession;
}
