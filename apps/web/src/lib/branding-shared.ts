/** The platform's name and logo as the pages use them (D-430, D-431). */
export interface Branding {
  productName: string;
  /** Same-origin URL of the logo, keyed by its version, or null when none is set. */
  logoUrl: string | null;
}

/** The cache tag of `GET /public/branding` in the web server's data cache. */
export const BRANDING_TAG = "branding";

/** The logo is served from this origin (CSP `img-src 'self'`), through the web app's own route. */
export const LOGO_PATH = "/api/branding/logo";

export function logoUrl(version: string): string {
  return `${LOGO_PATH}?v=${encodeURIComponent(version)}`;
}

/** What the logo upload accepts; the API checks the bytes again and is the authority (D-433). */
export const LOGO_ACCEPT = ["image/png", "image/jpeg", "image/webp"] as const;
export const LOGO_MAX_BYTES = 256 * 1024;
