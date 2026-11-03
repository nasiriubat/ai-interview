/**
 * The participant cookie as a production build names it (D-264): `__Host-` prefixed, so it must be
 * Secure, host-only and on `/`. The specs set the bare legacy name for three weeks after the rename,
 * and every participant page they visited rendered "this interview is no longer available".
 */
export const PARTICIPANT_COOKIE = { name: "__Host-aidp_participant", secure: true, path: "/" } as const;
