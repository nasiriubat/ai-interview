import {
  reconcileBackgroundProgress,
  type ExtractionCommit,
  type NewMessage,
  type SessionSnapshot,
  type SessionStore,
  type StoredMessage,
} from "@aidp/ai";
import { SessionStateSchema, type Fact, type InterviewTemplate, type SessionState } from "@aidp/shared";

/** Where `commitExtraction` throws, to prove the commit is all-or-nothing. */
export type CommitFailPoint = "after_state" | "after_rows" | "after_event";

/** What the `Fact` table would hold for one row. */
export interface FactRow {
  companyId: string;
  sessionId: string;
  kind: string;
  fact: Fact;
  extractorVersion: string;
  batchEndSeq: number;
  ordinal: number;
}

/**
 * One session's persistence, in memory. Behaves like `PrismaSessionStore` where it matters to the
 * jobs: whole-state writes are reconciled against the stored cursors, summary and extraction
 * commits patch only their own keys, and an extraction batch is a compare-and-set that either
 * applies completely or not at all.
 *
 * `failAt` throws part-way through `commitExtraction`; the store then restores exactly what it had
 * before the call, as a rolled-back transaction would.
 */
export class MemorySessionStore implements SessionStore {
  messages: StoredMessage[] = [];
  state: SessionState;
  summary = "";
  status = "active";
  events: { type: string; payload: unknown }[] = [];
  factRows: FactRow[] = [];
  failAt: CommitFailPoint | undefined;
  /** Every commit that reached the store, applied or not, for assertions on retry behaviour. */
  commits: { fromSeq: number; toSeq: number; outcome: "committed" | "stale" | "failed" }[] = [];

  constructor(
    readonly sessionId = "s1",
    initial: Partial<SessionState> = {},
  ) {
    this.state = SessionStateSchema.parse(initial);
  }

  async appendMessage(_id: string, m: NewMessage): Promise<StoredMessage> {
    const stored: StoredMessage = {
      ...m,
      id: `m${this.messages.length + 1}`,
      seq: this.messages.length + 1,
      createdAt: new Date(),
    };
    this.messages.push(stored);
    return stored;
  }

  async recentMessages(_id: string, limit: number): Promise<StoredMessage[]> {
    return this.messages.slice(-limit);
  }

  async messagesAfter(_id: string, seq: number): Promise<StoredMessage[]> {
    return this.messages.filter((m) => m.seq > seq);
  }

  async saveState(_id: string, state: SessionState): Promise<void> {
    this.state = reconcileBackgroundProgress(this.state, state);
  }

  async commitSummary(_id: string, summary: string, upToSeq: number): Promise<void> {
    this.summary = summary;
    this.state = { ...this.state, summaryUpToSeq: Math.max(this.state.summaryUpToSeq, upToSeq) };
  }

  async appendEvent(_id: string, type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
  }

  async commitExtraction(_id: string, c: ExtractionCommit): Promise<"committed" | "stale"> {
    if (this.status === "deleted" || this.state.lastExtractedSeq !== c.fromSeq) {
      this.commits.push({ fromSeq: c.fromSeq, toSeq: c.toSeq, outcome: "stale" });
      return "stale";
    }
    const before = {
      state: this.state,
      factRows: [...this.factRows],
      events: [...this.events],
    };
    try {
      this.state = { ...this.state, facts: [...this.state.facts, ...c.facts], lastExtractedSeq: c.toSeq };
      this.maybeFail("after_state");
      c.facts.forEach((fact, ordinal) => {
        const taken = this.factRows.some((r) => r.batchEndSeq === c.toSeq && r.ordinal === ordinal);
        if (!taken)
          this.factRows.push({
            companyId: c.companyId,
            sessionId: this.sessionId,
            kind: fact.kind,
            fact,
            extractorVersion: c.extractorVersion,
            batchEndSeq: c.toSeq,
            ordinal,
          });
      });
      this.maybeFail("after_rows");
      this.events.push({ type: "facts_extracted", payload: c.event });
      this.maybeFail("after_event");
    } catch (err) {
      this.state = before.state;
      this.factRows = before.factRows;
      this.events = before.events;
      this.commits.push({ fromSeq: c.fromSeq, toSeq: c.toSeq, outcome: "failed" });
      throw err;
    }
    this.commits.push({ fromSeq: c.fromSeq, toSeq: c.toSeq, outcome: "committed" });
    return "committed";
  }

  /** The snapshot a job would load: current state and summary, with the template attached. */
  snapshot(template: InterviewTemplate, companyId = "c1"): SessionSnapshot & { status: string } {
    return {
      id: this.sessionId,
      companyId,
      template,
      state: this.state,
      summary: this.summary,
      status: this.status,
    };
  }

  private maybeFail(point: CommitFailPoint): void {
    if (this.failAt === point) throw new Error(`injected failure ${point}`);
  }
}
