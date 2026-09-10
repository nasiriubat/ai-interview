import type { Path, WidgetResponse } from "@aidp/shared";
import { request, requestStream, type Transport } from "./http";
import {
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
  modality: "text" | "widget";
  widgetResponse?: WidgetResponse;
}

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
    setMode: (mode) =>
      request(transport, { method: "POST", path: "/p/session/mode", body: { mode }, schema: OkSchema }).then(
        () => undefined,
      ),
    sendTurn: (input, signal) =>
      requestStream(transport, {
        method: "POST",
        path: "/p/session/turns",
        ...(input ? { body: input } : {}),
        signal,
      }),
    pause: () =>
      request(transport, { method: "POST", path: "/p/session/pause", schema: OkSchema }).then(
        () => undefined,
      ),
    complete: () =>
      request(transport, { method: "POST", path: "/p/session/complete", schema: OkSchema }).then(
        () => undefined,
      ),
    deleteData: () =>
      request(transport, { method: "DELETE", path: "/p/session", schema: OkSchema }).then(() => undefined),
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
  getSession(): Promise<ParticipantSession>;
  consent(input: ConsentInput): Promise<void>;
  setPath(path: Path): Promise<void>;
  setMode(mode: ModePreference): Promise<void>;
  /** First turn: pass `undefined` to send an empty body. Returns the SSE response. */
  sendTurn(input: TurnInput | undefined, signal?: AbortSignal): Promise<Response>;
  pause(): Promise<void>;
  complete(): Promise<void>;
  deleteData(): Promise<void>;
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
