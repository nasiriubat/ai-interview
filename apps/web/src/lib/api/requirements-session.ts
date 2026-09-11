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
    summary: null,
  };
}

/**
 * Adapts the staff requirements routes (contract 18) to the participant API so the
 * existing interview hook drives an owner session. Pausing is a no-op (the owner just
 * leaves the page); deleting data and the participant summary are not part of the
 * owner flow and reject with "not available".
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
    pause: () => Promise.resolve(),
    complete: () => r.complete(id),
    deleteData: notAvailable,
    getSummary: notAvailable,
    putSummary: notAvailable,
  };
}
