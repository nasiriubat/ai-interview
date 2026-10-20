import { headers } from "next/headers";
import { publicOrigin } from "@/lib/landing";

/**
 * `/sitemap.xml`: the public pages, the landing page and the pilot request form. The staff area, sign-in and participant links are not listed.
 * One URL serves both languages (the language follows the visitor's cookie or Accept-Language),
 * so there are no alternates to declare.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const h = await headers();
  const origin = publicOrigin({ host: h.get("host"), forwardedProto: h.get("x-forwarded-proto") });
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    `  <url><loc>${origin}/</loc></url>`,
    `  <url><loc>${origin}/pilot</loc></url>`,
    "</urlset>",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}
