import { ProviderError, speechLanguages, UnsupportedAudioError } from "@aidp/ai";
import { AttachmentRejected } from "@aidp/core";
import type { FastifyRequest } from "fastify";
import type { App } from "../../app.js";
import { guard } from "../../auth/access.js";
import { participant } from "../../auth/plugin.js";
import type { AppContext } from "../../context.js";
import { AppError } from "../../lib/errors.js";
import { runTurn } from "../sessions/turn-runner.js";

/**
 * Recorded voice (FR-30): the browser records, this transcribes, and the transcript becomes the
 * participant's turn.
 *
 * One request, not two, and that is the whole design decision. Uploading and then separately
 * taking a turn would leave a window where the recording is stored but the answer was never given
 * — the participant closes the tab, and a session sits there with orphaned audio and no turn. Here
 * the audio is stored, transcribed and answered in one call, and the turn streams back exactly as
 * a typed answer does, so the client's existing stream reader needs no new branch.
 *
 * The audio is kept, not discarded after transcription: the spec asks for it to be playable, and a
 * transcript is a lossy record of what someone said about their own work. It is deleted with the
 * session, and swept by `privacy.audioRetentionDays`.
 */

/** A recording longer than this is almost certainly a stuck recorder rather than an answer. */
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const AUDIO_MIMES = new Set([
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/flac",
]);

export async function participantVoiceRoutes(app: App, ctx: AppContext): Promise<void> {
  app.post(
    "/p/session/voice-turns",
    {
      // Tighter than the typed-turn limit: every one of these is an upload plus a paid
      // transcription, so a loop here costs money rather than only cycles.
      ...guard.participant({ config: { rateLimit: { max: 12, timeWindow: "1 minute" } } }),
      schema: { hide: true },
    },
    async (req, reply) => {
      const p = participant(req);
      const enabled = await ctx.settings.get("features.recordedVoice", [
        { scope: "tenant", scopeId: p.companyId },
      ]);
      if (!enabled) throw new AppError("forbidden", "Voice answers are turned off");

      const file = await readAudio(req);
      const bytes = await file.toBuffer();
      const durationMs = durationFrom(file);

      let attachmentId: string | undefined;
      try {
        const created = await ctx.attachments.create({
          companyId: p.companyId,
          sessionId: p.sessionId,
          filename: file.filename || "recording.webm",
          mime: file.mimetype,
          bytes,
          ...(durationMs === undefined ? {} : { durationMs }),
        });
        attachmentId = created.id;
      } catch (err) {
        if (err instanceof AttachmentRejected) {
          throw new AppError(err.reason === "size" ? "too_large" : "validation", err.message);
        }
        throw err;
      }

      const caller = await ctx.callers.forCompany(p.companyId);
      const languages = speechLanguages(await ctx.attachments.languageFor(p.sessionId));
      let transcript;
      try {
        transcript = await caller.transcribe(
          { companyId: p.companyId, sessionId: p.sessionId, ref: { type: "attachment", id: attachmentId } },
          {
            data: new Uint8Array(bytes),
            mime: file.mimetype,
            filename: file.filename || "recording.webm",
            languages,
          },
        );
      } catch (err) {
        // The recording is kept even though the turn failed. The participant can retry, and the
        // audio of what they already said should not be thrown away because a provider was down.
        await markFailed(ctx, attachmentId, err);
        if (err instanceof UnsupportedAudioError) {
          // The on-server Whisper reads WAV, and this browser could not convert its recording
          // (D-75). Recording again will fail the same way, so the honest advice is to type.
          throw new AppError(
            "validation",
            "This browser's recording could not be read here; please type your answer instead",
          );
        }
        if (err instanceof ProviderError && err.code === "unsupported") {
          throw new AppError(
            "provider_error",
            "Voice answers need a transcription model, which is not configured yet",
          );
        }
        throw err;
      }

      const text = transcript.text.trim();
      await recordTranscription(ctx, attachmentId, transcript);

      if (text.length === 0) {
        // Silence, or a microphone that recorded nothing. Saying so beats sending an empty answer
        // to the interviewer, which would produce a confused follow-up question.
        throw new AppError("validation", "I could not hear anything in that recording");
      }

      const spoken = text.slice(0, 8000);
      await runTurn(ctx, p.sessionId, { content: spoken, modality: "voice" }, reply, {
        // The participant never typed this, so the stream has to tell them what was heard before
        // the interviewer replies to it. It also gives them the chance to notice a bad transcript.
        prelude: [
          {
            event: "transcript",
            data: {
              text: spoken,
              attachmentId,
              ...(transcript.confidence === undefined ? {} : { confidence: transcript.confidence }),
              ...(transcript.durationSeconds === undefined
                ? {}
                : { durationMs: Math.round(transcript.durationSeconds * 1000) }),
            },
          },
        ],
      });
    },
  );
}

async function readAudio(req: FastifyRequest) {
  if (!req.isMultipart()) throw new AppError("validation", "Expected a multipart upload");
  const file = await req.file({ limits: { fileSize: MAX_AUDIO_BYTES, files: 1 } });
  if (!file) throw new AppError("validation", "No recording in the upload");
  // Browsers append codec parameters, e.g. `audio/webm;codecs=opus`.
  const mime = file.mimetype.split(";")[0]?.trim() ?? "";
  if (!AUDIO_MIMES.has(mime)) throw new AppError("validation", "That is not a supported recording");
  return { ...file, mimetype: mime, toBuffer: file.toBuffer.bind(file), fields: file.fields };
}

function durationFrom(file: { fields: Record<string, unknown> }): number | undefined {
  const raw = file.fields.durationMs;
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) && "value" in raw ? raw.value : undefined;
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 && parsed < 3_600_000 ? parsed : undefined;
}

/**
 * Records what the transcription reported: its own duration, which is what the provider actually
 * billed for, and its confidence, which is one of the three voice signals the spec asks to trace.
 */
async function recordTranscription(
  ctx: AppContext,
  attachmentId: string,
  transcript: { text: string; durationSeconds?: number; confidence?: number },
): Promise<void> {
  await ctx.db.attachment.update({
    where: { id: attachmentId },
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

async function markFailed(ctx: AppContext, attachmentId: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  await ctx.db.attachment
    .update({
      where: { id: attachmentId },
      data: { status: "failed", error: message.slice(0, 500), ingestedAt: new Date() },
    })
    .catch(() => undefined);
}
