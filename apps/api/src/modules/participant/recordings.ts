import type { PrismaClient } from "@prisma/client";

/**
 * What a transcription did to the stored recording. A recording is kept even when the turn that
 * used it failed, so both outcomes are written onto the attachment row.
 */
export class RecordingStore {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Records what the transcription reported: its own duration, which is what the provider actually
   * billed for, and its confidence, which is one of the three voice signals the spec asks to trace.
   */
  async recordTranscription(
    companyId: string,
    attachmentId: string,
    transcript: { text: string; durationSeconds?: number; confidence?: number },
  ): Promise<void> {
    await this.db.attachment.updateMany({
      where: { id: attachmentId, companyId },
      data: {
        status: "ready",
        extractedText: transcript.text.slice(0, 200_000),
        ingestedAt: new Date(),
        ...(transcript.durationSeconds === undefined
          ? {}
          : { durationMs: Math.round(transcript.durationSeconds * 1000) }),
        ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence }),
      },
    });
  }

  /** Never throws: it runs while another failure is already being reported. */
  async markFailed(companyId: string, attachmentId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    await this.db.attachment
      .updateMany({
        where: { id: attachmentId, companyId },
        data: { status: "failed", error: message.slice(0, 500), ingestedAt: new Date() },
      })
      .catch(() => undefined);
  }
}
