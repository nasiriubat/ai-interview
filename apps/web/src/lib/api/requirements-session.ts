import { staffClient } from "./browser";
import type { ParticipantApi } from "./participant";
import type { ParticipantSession, RequirementsDetail } from "./schemas";
import type { StaffApi } from "./staff";

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
    // The owner can dictate into the answer box (D-483) and attach their own material (D-490); the
    // server holds both to the tenant's switches. There is no live voice on the owner's side.
    capabilities: {
      recordedVoice: true,
      liveVoice: false,
      captions: false,
      fileUpload: detail.uploads.enabled,
      maxSizeMb: detail.uploads.maxSizeMb,
      allowedTypes: detail.uploads.allowedTypes,
    },
    attachments: detail.attachments,
    summary: null,
  };
}

/**
 * Adapts the staff requirements routes (contract 18) to the participant API so the
 * existing interview hook drives an owner session. Pausing is a no-op (the owner just
 * leaves the page); deleting data and the participant summary are not part of the
 * owner flow and reject with "not available". So do sent voice turns, a participant route
 * (FR-30). Dictation (D-483) and attachments (D-490) are the owner's own routes.
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
    uploadAttachment: (file, _durationMs, options) => r.attachments.upload(id, file, options),
    listAttachments: () => r.attachments.list(id),
    attachmentBytes: (attachmentId) => r.attachments.bytes(id, attachmentId),
    deleteAttachment: (attachmentId) => r.attachments.remove(id, attachmentId),
    pause: () => Promise.resolve(),
    deleteData: notAvailable,
    getSummary: notAvailable,
    putSummary: notAvailable,
  };
}
