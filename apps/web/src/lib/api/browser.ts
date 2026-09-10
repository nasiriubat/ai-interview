"use client";

import { createTransport } from "./http";
import { participantApi, type ParticipantApi } from "./participant";
import { staffApi, type StaffApi } from "./staff";

/**
 * Browser clients go through the Next route handlers under `/api/*`, which attach the
 * credential from the httpOnly cookie. No token is ever readable from client JavaScript.
 */
export const participantClient: ParticipantApi = participantApi(createTransport("/api/participant"));
export const staffClient: StaffApi = staffApi(createTransport("/api/staff"));
