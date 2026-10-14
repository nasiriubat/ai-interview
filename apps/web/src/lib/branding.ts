import "server-only";
import { cache } from "react";
import { getStrings } from "@/i18n/server";
import { PublicBrandingSchema } from "@/lib/api/schemas";
import { BRANDING_TAG, logoUrl, type Branding } from "@/lib/branding-shared";
import { apiBaseUrl } from "@/lib/env";

export { BRANDING_TAG, type Branding } from "@/lib/branding-shared";

/**
 * How long the web server keeps the answer (D-431). A minute: a rename or a new logo shows within
 * that without anyone purging anything, and the operator's own change is seen at once because
 * the staff proxy expires the tag after a write. `BRANDING_CACHE_SECONDS=0` turns caching off,
 * for the visual review, which switches the fake API's logo on and off between shots.
 */
function cacheSeconds(): number {
  const raw = Number(process.env.BRANDING_CACHE_SECONDS ?? 60);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60;
}

/** What the pages show when the API cannot be asked: the bundled `app.name` of the request's language. */
async function fallback(): Promise<Branding> {
  return { productName: (await getStrings()).app.name, logoUrl: null };
}

/**
 * The platform's name and logo for this request, from `GET /public/branding` (D-431).
 *
 * Asked with no visitor header at all, so the cache entry is shared by every visitor. If the API
 * is slow, down or answers something unexpected, the page still renders under the bundled name:
 * the brand is decoration, and no page may fail for want of it.
 */
export const getBranding = cache(async (): Promise<Branding> => {
  try {
    const seconds = cacheSeconds();
    const res = await fetch(`${apiBaseUrl()}/public/branding`, {
      signal: AbortSignal.timeout(2000),
      headers: { accept: "application/json" },
      ...(seconds === 0
        ? { cache: "no-store" as const }
        : { next: { revalidate: seconds, tags: [BRANDING_TAG] } }),
    });
    if (!res.ok) return await fallback();
    const parsed = PublicBrandingSchema.safeParse(await res.json());
    if (!parsed.success) return await fallback();
    const { productName, hasLogo, logoVersion } = parsed.data;
    if (!productName.trim()) return await fallback();
    return { productName, logoUrl: hasLogo && logoVersion ? logoUrl(logoVersion) : null };
  } catch {
    return await fallback();
  }
});
