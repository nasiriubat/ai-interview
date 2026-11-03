import { staffClient } from "./browser";
import type { ParticipantApi } from "./participant";
import type { ParticipantSession, RequirementsDetail } from "./schemas";
import type { StaffApi } from "./staff";
import { DEFAULT_ALLOWED_TYPES, DEFAULT_MAX_SIZE_MB } from "@/lib/attachments";

const NOT_AVAILABLE = "not available";

function notAvailable<T>(): Promise<T> {
  return Promise.reject(new Error(NOT_AVAILABLE));
}

/** The owner's view of a requirements session in the shape `useInterview` expects. */
export function toParticipantSession(detail: RequirementsDetail): ParticipantSession {
  return {
    id: detail.session.id,
    status: detail.session.status,
    path: detail.session.path ?? null,
    modePreference: null,
    consented: true,
    progress: detail.session.progress,
    messages: detail.messages,
    // The owner can dictate into the answer box (D-483); the server still holds dictation to the
    // tenant's recorded-voice switch. There are no live-voice or attachment routes for the owner.
    capabilities: {
      recordedVoice: true,
      liveVoice: false,
      captions: false,
      fileUpload: false,
      maxSizeMb: DEFAULT_MAX_SIZE_MB,
      allowedTypes: [...DEFAULT_ALLOWED_TYPES],
    },
    attachments: [],
    summary: null,
  };
}

/**
 * Adapts the staff requirements routes (contract 18) to the participant API so the
 * existing interview hook drives an owner session. Pausing is a no-op (the owner just
 * leaves the page); deleting data and the participant summary are not part of the
 * owner flow and reject with "not available". So do sent voice turns and attachments: those are
 * participant routes (FR-30, FR-31). Dictation is the owner's own route (D-483).
 */
export function requirementsSessionApi(id: string, api: StaffApi = staffClient): ParticipantApi {
  const r = api.requirements;
  return {
    getLink: notAvailable,
    requestCode: notAvailable,
    confirmCode: notAvailable,
    open: notAvailable,
    getInvite: notAvailable,
    openInvite: notAvailable,
    getSession: () => r.get(id).then(toParticipantSession),
    consent: () => Promise.resolve(),
    setPath: (path) => r.setPath(id, path),
    setMode: () => Promise.resolve(),
    sendTurn: (input, signal) => r.sendTurn(id, input, signal),
    sendControl: (control, signal) => r.sendControl(id, control, signal),
    sendVoice: notAvailable,
    transcribe: (audio, durationMs) => r.transcribe(id, audio, durationMs),
    uploadAttachment: notAvailable,
    listAttachments: notAvailable,
    attachmentBytes: notAvailable,
    deleteAttachment: notAvailable,
    pause: () => Promise.resolve(),
    deleteData: notAvailable,
    getSummary: notAvailable,
    putSummary: notAvailable,
  };
}
