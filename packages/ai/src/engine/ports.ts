import type {
  Fact,
  Handoff,
  InterviewTemplate,
  Modality,
  Path,
  SessionEventType,
  SessionState,
  Widget,
  WidgetResponse,
} from "@aidp/shared";

export interface StoredMessage {
  id: string;
  seq: number;
  role: "user" | "assistant";
  modality: Modality;
  content: string;
  widget?: Widget;
  widgetResponse?: WidgetResponse;
  areaKey?: string;
  createdAt: Date;
}

export type NewMessage = Omit<StoredMessage, "id" | "seq" | "createdAt">;

/** Everything the engine needs to know about a session. Loaded by the caller, never fetched by the engine. */
export interface SessionSnapshot {
  id: string;
  companyId: string;
  campaignId?: string;
  template: InterviewTemplate;
  state: SessionState;
  summary: string;
  path?: Path;
  /** Requirements sessions started from a promoted opportunity (FR-66). Rendered into layer 2. */
  handoff?: Handoff;
  /**
   * What the participant has attached (FR-31), summarized. Rendered into layer 2 so the
   * interviewer knows every turn that a document exists and roughly what is in it; the wording
   * itself is retrieved on demand through the recall source.
   */
  attachments?: AttachedFile[];
}

export interface AttachedFile {
  filename: string;
  kind: string;
  /** Empty until ingestion finishes, or when it failed. */
  summary: string;
  status: string;
}

/**
 * One extraction batch, committed as a unit (FR-14, NFR-09).
 *
 * The model call that produced `facts` happens before this and outside any transaction. What is
 * atomic is everything after it: the fact rows, the session state's `facts` and
 * `lastExtractedSeq`, and the `facts_extracted` event either all land or none do.
 */
export interface ExtractionCommit {
  companyId: string;
  /** The cursor this batch was extracted from. The commit is rejected if the stored cursor differs. */
  fromSeq: number;
  /** Highest message sequence this batch covered; becomes the new cursor. */
  toSeq: number;
  /** This batch's facts only; the store appends them to what the session already holds. */
  facts: Fact[];
  /** `promptVersionTag` of the prompt that produced them, never a literal. */
  extractorVersion: string;
  /** The language the interview was conducted in (the template's), stored on each fact row. */
  language?: string;
  /** Payload of the `facts_extracted` event written in the same transaction. */
  event: { count: number; upToSeq: number; promptVersion: string; quotesDropped?: number };
}

/** Persistence port. The API implements it with Prisma; tests use memory. */
export interface SessionStore {
  appendMessage(sessionId: string, message: NewMessage): Promise<StoredMessage>;
  recentMessages(sessionId: string, limit: number): Promise<StoredMessage[]>;
  messagesAfter(sessionId: string, seq: number): Promise<StoredMessage[]>;
  saveState(sessionId: string, state: SessionState): Promise<void>;
  /**
   * Stores a folded summary and advances `summaryUpToSeq` without rewriting the rest of the
   * state. The summary job runs beside live turns, so writing its whole (older) snapshot back
   * would undo whatever the turn did in between.
   */
  commitSummary(sessionId: string, summary: string, upToSeq: number): Promise<void>;
  appendEvent(sessionId: string, type: SessionEventType, payload: unknown): Promise<void>;
  /**
   * Persists one extraction batch atomically, with compare-and-set on the cursor.
   *
   * Returns `"stale"` and writes nothing when the stored `lastExtractedSeq` is no longer
   * `fromSeq` (another run committed first, a retry overlapped its still-running original) or the
   * session was deleted. The rows are keyed by (session, `toSeq`, ordinal), so replaying a batch
   * that did commit is harmless even if the compare-and-set is bypassed.
   */
  commitExtraction(sessionId: string, commit: ExtractionCommit): Promise<"committed" | "stale">;
}

/** Finds older material by meaning. Phase 1 ships a lexical implementation; phase 4 adds embeddings. */
export interface RecallSource {
  recall(sessionId: string, query: string, limit: number): Promise<{ seq: number; text: string }[]>;
}

/** ADM-REQ knobs resolved from the settings catalog. `template` defers to the template's issueDetection. */
export interface RequirementsSettings {
  aggressivenessTechnical: "template" | "gentle" | "standard" | "strict";
  aggressivenessNontechnical: "template" | "gentle" | "standard" | "strict";
  mvpChallenge: "template" | "mandatory" | "optional" | "off";
}

export interface EngineSettings {
  recentWindowTurns: number;
  inputTokenBudget: number;
  summarizeEveryTurns: number;
  extractEveryTurns: number;
  maxTurns: number;
  requirements?: RequirementsSettings;
}

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
}
