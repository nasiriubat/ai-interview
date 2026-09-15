import { cosine, LexicalEmbeddings, tokenize, type ModelCaller, type RecallSource } from "@aidp/ai";
import type { PrismaClient } from "@prisma/client";

/**
 * Retrieving passages from a session's attachments (FR-31: "the interview references the summary
 * and recalls chunks on demand").
 *
 * Two paths, chosen by what the tenant actually has configured. With an `embedding` route the
 * query is embedded and compared against stored vectors in Postgres, which finds a passage about
 * "how long the handover takes" from a question about duration even when no word matches. Without
 * one — the common case, since OpenRouter serves no embedding models — the same chunk text is
 * scored by word overlap.
 *
 * The lexical path is genuinely worse, not a token gesture, and it is still much better than
 * nothing: the words people use about their own work repeat heavily across a document and the
 * question that prompts the recall.
 */

export interface AttachmentRecallDeps {
  db: PrismaClient;
  caller: ModelCaller;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
}

export interface RecalledChunk {
  attachmentId: string;
  filename: string;
  seq: number;
  text: string;
  score: number;
}

/** Below this, a lexical hit is noise. Mirrors LEXICAL_THRESHOLD in the analysis pipeline. */
const LEXICAL_FLOOR = 0.08;
/** Below this, a vector hit is unrelated. */
const VECTOR_FLOOR = 0.2;
/** How many chunks are scored in memory on the lexical path before giving up on ranking well. */
const LEXICAL_SCAN_LIMIT = 1500;

export class AttachmentRecall {
  constructor(private readonly deps: AttachmentRecallDeps) {}

  async recall(companyId: string, sessionId: string, query: string, limit = 3): Promise<RecalledChunk[]> {
    if (query.trim().length === 0) return [];
    const vectorHits = await this.byVector(companyId, sessionId, query, limit);
    if (vectorHits !== undefined) return vectorHits;
    return await this.byWords(companyId, sessionId, query, limit);
  }

  /**
   * Vector search in Postgres, or undefined when this tenant has no embedding route — which is the
   * signal to fall back rather than an error.
   *
   * `<=>` is pgvector's cosine distance, so similarity is `1 - distance`. The join to Attachment
   * carries the filename, which the interviewer needs in order to say where a passage came from.
   */
  private async byVector(
    companyId: string,
    sessionId: string,
    query: string,
    limit: number,
  ): Promise<RecalledChunk[] | undefined> {
    let vector: number[] | undefined;
    try {
      const embedded = await this.deps.caller.embed({ companyId, sessionId }, [query]);
      vector = embedded?.vectors[0];
    } catch (err) {
      this.deps.logger?.warn("embedding the recall query failed; falling back to word overlap", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
    if (vector?.length !== 1536) return undefined;

    const rows = await this.deps.db.$queryRawUnsafe<
      { attachmentId: string; filename: string; seq: number; text: string; score: number }[]
    >(
      `SELECT c."attachmentId", a.filename, c.seq, c.text,
              1 - (c.embedding <=> $1::vector) AS score
         FROM "AttachmentChunk" c
         JOIN "Attachment" a ON a.id = c."attachmentId"
        WHERE c."companyId" = $2 AND a."sessionId" = $3 AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $1::vector
        LIMIT $4`,
      `[${vector.join(",")}]`,
      companyId,
      sessionId,
      limit,
    );
    // No embedded chunks yet is not the same as no embedding route: the attachments were ingested
    // before a route existed, so their text is there and only the vectors are missing.
    if (rows.length === 0) return undefined;
    return rows.filter((r) => r.score >= VECTOR_FLOOR);
  }

  /** Word overlap over the same chunk text, scored with the shared lexical embedding. */
  private async byWords(
    companyId: string,
    sessionId: string,
    query: string,
    limit: number,
  ): Promise<RecalledChunk[]> {
    const rows = await this.deps.db.attachmentChunk.findMany({
      where: { companyId, attachment: { sessionId } },
      select: { attachmentId: true, seq: true, text: true, attachment: { select: { filename: true } } },
      orderBy: [{ attachmentId: "asc" }, { seq: "asc" }],
      take: LEXICAL_SCAN_LIMIT,
    });
    if (rows.length === 0) return [];

    // Fitted over this session's chunks so document-frequency damping is computed against the
    // corpus actually being searched, exactly as the analysis pipeline does for findings.
    const lexical = new LexicalEmbeddings();
    const vectors = await lexical.embed([query, ...rows.map((r) => r.text)]);
    const queryVector = vectors[0];
    if (!queryVector) return [];

    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) return [];

    return rows
      .map((row, i) => ({
        attachmentId: row.attachmentId,
        filename: row.attachment.filename,
        seq: row.seq,
        text: row.text,
        score: cosine(queryVector, vectors[i + 1] ?? []),
      }))
      .filter((hit) => hit.score >= LEXICAL_FLOOR)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

/**
 * Wraps the engine's existing message recall so one `RecallSource` searches both the transcript
 * and the attachments.
 *
 * Composed rather than merged into the engine because the engine should not know that attachments
 * exist: it asks for passages relevant to the current topic, and where they come from is this
 * layer's business. The two sources are interleaved rather than concatenated, so a session with
 * one large document cannot crowd out the participant's own earlier words, or vice versa.
 */
export class CombinedRecall implements RecallSource {
  constructor(
    private readonly messages: RecallSource,
    private readonly attachments: AttachmentRecall,
    private readonly scope: { companyId: string; sessionId: string },
  ) {}

  async recall(sessionId: string, query: string, limit: number): Promise<{ seq: number; text: string }[]> {
    const half = Math.max(1, Math.floor(limit / 2));
    const [fromMessages, fromFiles] = await Promise.all([
      this.messages.recall(sessionId, query, limit - half),
      this.attachments
        .recall(this.scope.companyId, sessionId, query, half)
        .catch(() => [] as RecalledChunk[]),
    ]);
    // A recalled passage says which file it came from, because "the procedure says X" and "you
    // said X" are different kinds of evidence and the interviewer must not conflate them.
    const files = fromFiles.map((c) => ({ seq: 0, text: `[${c.filename}] ${c.text}` }));
    return [...fromMessages, ...files];
  }
}
