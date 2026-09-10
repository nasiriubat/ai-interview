import { renderStoredMessage } from "./context.js";
import type { RecallSource, SessionStore } from "./ports.js";

const STOP = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "it",
  "that",
  "this",
  "i",
  "we",
  "you",
]);

/**
 * Phase 1 recall: keyword overlap over messages older than the recent window.
 * Replaced by embedding search in phase 4 without changing the engine.
 */
export class LexicalRecall implements RecallSource {
  constructor(
    private readonly store: SessionStore,
    private readonly recentWindowTurns: number,
  ) {}

  async recall(sessionId: string, query: string, limit: number): Promise<{ seq: number; text: string }[]> {
    const terms = tokens(query);
    if (terms.size === 0) return [];
    const all = await this.store.messagesAfter(sessionId, 0);
    const older = all
      .slice(0, Math.max(0, all.length - this.recentWindowTurns * 2))
      .filter((m) => m.role === "user");
    return older
      .map((m) => {
        const text = renderStoredMessage(m);
        const words = tokens(text);
        let score = 0;
        for (const t of terms) if (words.has(t)) score++;
        return { seq: m.seq, text: text.slice(0, 300), score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.seq - b.seq)
      .slice(0, limit)
      .map(({ seq, text }) => ({ seq, text }));
  }
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9äöå]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
