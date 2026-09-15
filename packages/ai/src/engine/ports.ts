import type {
  Handoff,
  InterviewTemplate,
  Modality,
  Path,
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

/** Persistence port. The API implements it with Prisma; tests use memory. */
export interface SessionStore {
  appendMessage(sessionId: string, message: NewMessage): Promise<StoredMessage>;
  recentMessages(sessionId: string, limit: number): Promise<StoredMessage[]>;
  messagesAfter(sessionId: string, seq: number): Promise<StoredMessage[]>;
  saveState(sessionId: string, state: SessionState): Promise<void>;
  saveSummary(sessionId: string, summary: string): Promise<void>;
  appendEvent(sessionId: string, type: string, payload: unknown): Promise<void>;
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
