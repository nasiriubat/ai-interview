import type { Path, TurnControl, WidgetResponse } from "@aidp/shared";
import { z } from "zod";
import { request, requestBlob, requestStream, type Transport } from "./http";
import {
  type Attachment,
  AttachmentEnvelopeSchema,
  DeleteResultSchema,
  type DeleteResult,
  AttachmentListSchema,
  type InviteArrival,
  InviteArrivalSchema,
  LinkInfoSchema,
  type LinkInfo,
  type ModePreference,
  OkSchema,
  ParticipantSessionEnvelopeSchema,
  type ParticipantSession,
  SessionGrantSchema,
  type SessionGrant,
  SummarySchema,
  type Summary,
  TokenGrantSchema,
  type TokenGrant,
} from "./schemas";

export interface TurnInput {
  content: string;
  modality: "text" | "dictated" | "widget";
  widgetResponse?: WidgetResponse;
}

/** The extension the API's audio allowlist expects for each recording container. */
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

/** Browsers append codec parameters (`audio/webm;codecs=opus`); the extension follows the container. */
export const TranscriptSchema = z.looseObject({ text: z.string() });

export function recordingName(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  return `recording.${AUDIO_EXTENSIONS[base] ?? "webm"}`;
}

export function uploadForm(file: Blob, filename: string, durationMs?: number): FormData {
  const form = new FormData();
  form.append("file", file, filename);
  if (durationMs !== undefined) form.append("durationMs", String(Math.round(durationMs)));
  return form;
}

/** Why the answer mode changed when the participant did not pick it (contract 16). */
export type ModeSwitchReason = "participant" | "fallback_captions" | "fallback_typing" | "unavailable";

export interface ConsentInput {
  consentVersion: string;
  participantFields?: Record<string, string>;
  participationChoice?: "identified" | "anonymous";
}

/**
 * Participant endpoints. The link endpoints are public; the session endpoints need the
 * participant token, which the transport supplies (server: from the cookie; browser: via
 * the `/api/participant` proxy).
 */
export function participantApi(transport: Transport): ParticipantApi {
  return {
    getLink: (linkToken) =>
      request(transport, { path: `/p/${encodeURIComponent(linkToken)}`, schema: LinkInfoSchema }),
    requestCode: (linkToken, email) =>
      request(transport, {
        method: "POST",
        path: `/p/${encodeURIComponent(linkToken)}/verify/request`,
        body: { email },
        schema: OkSchema,
      }).then(() => undefined),
    confirmCode: (linkToken, email, code) =>
      request(transport, {
        method: "POST",
        path: `/p/${encodeURIComponent(linkToken)}/verify/confirm`,
        body: { email, code },
        schema: SessionGrantSchema,
      }),
    open: (linkToken, invitationToken) =>
      request(transport, {
        method: "POST",
        path: `/p/${encodeURIComponent(linkToken)}/open`,
        body: invitationToken ? { invitationToken } : {},
        schema: SessionGrantSchema,
      }),
    getInvite: (token) =>
      request(transport, { path: `/p/r/${encodeURIComponent(token)}`, schema: InviteArrivalSchema }),
    openInvite: (token) =>
      request(transport, {
        method: "POST",
        path: `/p/r/${encodeURIComponent(token)}/open`,
        body: {},
        schema: SessionGrantSchema,
      }),
    getSession: () =>
      request(transport, { path: "/p/session", schema: ParticipantSessionEnvelopeSchema }).then(
        (r) => r.session,
      ),
    consent: (input) =>
      request(transport, { method: "POST", path: "/p/session/consent", body: input, schema: OkSchema }).then(
        () => undefined,
      ),
    setPath: (path) =>
      request(transport, { method: "POST", path: "/p/session/path", body: { path }, schema: OkSchema }).then(
        () => undefined,
      ),
    setMode: (mode, reason) =>
      request(transport, {
        method: "POST",
        path: "/p/session/mode",
        body: reason ? { mode, reason } : { mode },
        schema: OkSchema,
      }).then(() => undefined),
    sendTurn: (input, signal) =>
      requestStream(transport, {
        method: "POST",
        path: "/p/session/turns",
        ...(input ? { body: input } : {}),
        signal,
      }),
    sendControl: (control, signal) =>
      requestStream(transport, {
        method: "POST",
        path: "/p/session/turns",
        body: { control },
        signal,
      }),
    sendVoice: (audio, durationMs, signal) =>
      requestStream(transport, {
        method: "POST",
        path: "/p/session/voice-turns",
        body: uploadForm(audio, recordingName(audio.type), durationMs),
        signal,
      }),
    transcribe: (audio, durationMs) =>
      request(transport, {
        method: "POST",
        path: "/p/session/transcribe",
        body: uploadForm(audio, recordingName(audio.type), durationMs),
        schema: TranscriptSchema,
      }).then((r) => r.text),
    uploadAttachment: (file, durationMs, options) =>
      request(transport, {
        method: "POST",
        path: "/p/session/attachments",
        body: uploadForm(file, file.name, durationMs),
        schema: AttachmentEnvelopeSchema,
        signal: options?.signal,
        onUploadProgress: options?.onProgress,
      }).then((r) => r.attachment),
    listAttachments: () =>
      request(transport, { path: "/p/session/attachments", schema: AttachmentListSchema }),
    attachmentBytes: (attachmentId) =>
      requestBlob(transport, { path: `/p/session/attachments/${encodeURIComponent(attachmentId)}` }),
    deleteAttachment: (attachmentId) =>
      request(transport, {
        method: "DELETE",
        path: `/p/session/attachments/${encodeURIComponent(attachmentId)}`,
        schema: OkSchema,
      }).then(() => undefined),
    pause: () =>
      request(transport, { method: "POST", path: "/p/session/pause", schema: OkSchema }).then(
        () => undefined,
      ),
    deleteData: () =>
      request(transport, { method: "DELETE", path: "/p/session", schema: DeleteResultSchema }),
    getSummary: () => request(transport, { path: "/p/session/summary", schema: SummarySchema }),
    putSummary: (summary) =>
      request(transport, {
        method: "PUT",
        path: "/p/session/summary",
        body: { summary },
        schema: OkSchema,
      }).then(() => undefined),
  };
}

export interface ParticipantApi {
  getLink(linkToken: string): Promise<LinkInfo>;
  requestCode(linkToken: string, email: string): Promise<void>;
  confirmCode(linkToken: string, email: string, code: string): Promise<SessionGrant>;
  open(linkToken: string, invitationToken?: string): Promise<SessionGrant>;
  /** Contract 18: an external person invited into a requirements session (`/p/r/:token`). */
  getInvite(token: string): Promise<InviteArrival>;
  /** Proxied like `open`: the token lands in the participant cookie, then `/p/session/*` applies. */
  openInvite(token: string): Promise<SessionGrant>;
  getSession(): Promise<ParticipantSession>;
  consent(input: ConsentInput): Promise<void>;
  setPath(path: Path): Promise<void>;
  /**
   * `reason` is why the mode changed when it was not the participant's own choice, so the
   * transcript can say so (`mode_switch` event, D-171). Omitted means the participant chose it.
   */
  setMode(mode: ModePreference, reason?: ModeSwitchReason): Promise<void>;
  /** First turn: pass `undefined` to send an empty body. Returns the SSE response. */
  sendTurn(input: TurnInput | undefined, signal?: AbortSignal): Promise<Response>;
  /**
   * A participant control (skip an area, come back to one, finish): applied by the engine as a
   * state operation and never stored as something the participant said (D-170). The response is a
   * turn stream that opens with a `control` event.
   */
  sendControl(control: TurnControl, signal?: AbortSignal): Promise<Response>;
  /**
   * Recorded voice (FR-30): uploads the recording and takes the turn in one request. The SSE
   * response is a turn stream that opens with a `transcript` event.
   */
  sendVoice(audio: Blob, durationMs?: number, signal?: AbortSignal): Promise<Response>;
  /**
   * Speech to text for one field (D-239): the words come back as a draft and nothing is stored or
   * answered. Used by the "Other" entry of a choice question.
   */
  transcribe(audio: Blob, durationMs?: number): Promise<string>;
  /** Uploads one file (FR-31). The attachment comes back before it has been read; watch `status`. */
  uploadAttachment(
    file: File,
    durationMs?: number,
    options?: { signal?: AbortSignal; onProgress?: (percent: number) => void },
  ): Promise<Attachment>;
  listAttachments(): Promise<Attachment[]>;
  /** The stored bytes, for playing a recording back. */
  attachmentBytes(attachmentId: string): Promise<Blob>;
  deleteAttachment(attachmentId: string): Promise<void>;
  pause(): Promise<void>;
  /** `emailSent` is true when a deletion confirmation was queued, which only an identified participant gets. */
  deleteData(): Promise<DeleteResult>;
  getSummary(): Promise<Summary>;
  putSummary(summary: string): Promise<void>;
}

/** Server-only: the raw token grant as the API returns it (before the proxy moves it into the cookie). */
export function participantTokenApi(transport: Transport): {
  confirmCode(linkToken: string, email: string, code: string): Promise<TokenGrant>;
  open(linkToken: string, invitationToken?: string): Promise<TokenGrant>;
} {
  return {
    confirmCode: (linkToken, email, code) =>
      request(transport, {
        method: "POST",
        path: `/p/${encodeURIComponent(linkToken)}/verify/confirm`,
        body: { email, code },
        schema: TokenGrantSchema,
      }),
    open: (linkToken, invitationToken) =>
      request(transport, {
        method: "POST",
        path: `/p/${encodeURIComponent(linkToken)}/open`,
        body: invitationToken ? { invitationToken } : {},
        schema: TokenGrantSchema,
      }),
  };
}
