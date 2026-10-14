/**
 * Where a participant's data lives, and what happens to it when they ask for a copy or for
 * erasure (GDPR Art. 15, 17, 20; FR-13, D-162).
 *
 * This is the contract behind two promises: "Download my data" contains everything about the
 * person, and "Delete my data" leaves nothing about them. A test reads `information_schema` and
 * fails when a table that holds participant-linked columns is missing from this list, so a new
 * table cannot ship without a decision about both.
 */

/** How a table is represented in the participant's own export. */
export type ExportTreatment =
  /** Included in the export, under the named section. */
  | { kind: "included"; section: string }
  /** Computed from many people's answers, or from the engine's internals, and not theirs to take. */
  | { kind: "derived"; why: string }
  /** Holds no content about the person (counters, cost). */
  | { kind: "not_personal"; why: string }
  /** A keyed hash that cannot be read back, so there is nothing to give. */
  | { kind: "pseudonymous"; why: string };

/** What erasure does to it. Verified by the erasure canary scan (packages/core/test). */
export type ErasureTreatment =
  | "deleted" // rows removed with the session
  | "anonymised" // row kept, personal columns cleared
  | "scrubbed" // aggregate kept, the participant's words replaced
  | "retained"; // kept because it holds nothing about the person

export interface TableCoverage {
  export: ExportTreatment;
  erasure: ErasureTreatment;
  note: string;
}

export const PARTICIPANT_DATA: Record<string, TableCoverage> = {
  Session: {
    export: { kind: "included", section: "session" },
    erasure: "anonymised",
    note: "Status, consent record and timing are exported. Erasure empties state, summary and handoff and keeps the row so the campaign's counts hold.",
  },
  Participant: {
    export: { kind: "included", section: "participant" },
    erasure: "deleted",
    note: "The fields the participant gave (name, role, address) are exported. The row is deleted.",
  },
  Message: {
    export: { kind: "included", section: "transcript" },
    erasure: "deleted",
    note: "Every question and answer, in order.",
  },
  Fact: {
    export: { kind: "included", section: "facts" },
    erasure: "deleted",
    note: "What the interviewer recorded about their work, with the quote it rests on.",
  },
  Attachment: {
    export: { kind: "included", section: "files" },
    erasure: "deleted",
    note: "Filename, type, size and summary of each file and recording. The bytes are removed from storage with the row.",
  },
  AttachmentChunk: {
    export: {
      kind: "derived",
      why: "A search index of text extracted from a listed file; the file's summary is exported.",
    },
    erasure: "deleted",
    note: "Cascades from Attachment.",
  },
  Invitation: {
    export: { kind: "included", section: "invitation" },
    erasure: "anonymised",
    note: "The address invited and when. Erasure clears the address, the link and the hash and keeps the row for send counts.",
  },
  SessionEvent: {
    export: {
      kind: "derived",
      why: "The engine's state log; the transcript and facts carry the same content.",
    },
    erasure: "deleted",
    note: "Replay log of state changes.",
  },
  SpecVersion: {
    export: {
      kind: "derived",
      why: "A requirements document generated for the session's owner, not a record about the participant.",
    },
    erasure: "deleted",
    note: "Only requirements sessions have these.",
  },
  OpportunityEvidence: {
    export: { kind: "derived", why: "Evidence snippets inside an aggregate analysis across the campaign." },
    erasure: "scrubbed",
    note: "Quotes in reports and opportunities are replaced with a marker and the analysis is flagged stale.",
  },
  Opportunity: {
    export: { kind: "derived", why: "An aggregate across many participants." },
    erasure: "scrubbed",
    note: "Counts and scores remain; verbatim quotes are replaced.",
  },
  LlmCall: {
    export: {
      kind: "not_personal",
      why: "Token counts, latency and cost; the content of a call is not stored.",
    },
    erasure: "retained",
    note: "The cost ledger keeps the session id; the session row is anonymised.",
  },
  CampaignEmailHash: {
    export: {
      kind: "pseudonymous",
      why: "A keyed hash of the address used to allow one response per person.",
    },
    erasure: "deleted",
    note: "Removed with the address (D-81): erasure outranks the one-response guarantee.",
  },
  EmailCode: {
    export: { kind: "pseudonymous", why: "A hash of a short-lived verification code." },
    erasure: "deleted",
    note: "Removed with the address.",
  },
};

/** Tables that match the scan but are about staff, not participants, and the reason. */
export const NOT_PARTICIPANT_TABLES: Record<string, string> = {
  User: "Staff identity. Offboarding is the disable and delete flow (P10, D-161).",
};
