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
    // The staff requirements routes carry no voice or attachment endpoints, so the owner's
    // session says so rather than offering controls that would 404.
    capabilities: {
      recordedVoice: false,
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
 * owner flow and reject with "not available". So do voice and attachments: those are
 * participant routes (FR-30, FR-31), and the owner workspace renders no controls for them.
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
    sendVoice: notAvailable,
    uploadAttachment: notAvailable,
    listAttachments: notAvailable,
    attachmentBytes: notAvailable,
    deleteAttachment: notAvailable,
    pause: () => Promise.resolve(),
    complete: () => r.complete(id),
    deleteData: notAvailable,
    getSummary: notAvailable,
    putSummary: notAvailable,
  };
}
