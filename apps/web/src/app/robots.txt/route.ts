import { headers } from "next/headers";
import { publicOrigin } from "@/lib/landing";

/**
 * `/robots.txt`: the front page may be indexed; the staff area, the API proxy and participant
 * links may not (a participant link is a credential, and nothing behind it is public).
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const h = await headers();
  const origin = publicOrigin({ host: h.get("host"), forwardedProto: h.get("x-forwarded-proto") });
  const body = [
    "User-agent: *",
    "Allow: /$",
    "Disallow: /admin",
    "Disallow: /api/",
    "Disallow: /auth/",
    "Disallow: /p/",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
}
