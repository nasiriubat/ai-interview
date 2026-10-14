/**
 * Small, pure helpers for the public landing page (`/`). Kept free of Next.js imports so they can
 * be unit tested.
 */

const ADDRESS_PART = String.raw`[^\s@<>"',;:()[\]\\?&#%=/]+`;
const ADDRESS = new RegExp(`^${ADDRESS_PART}@${ADDRESS_PART}\\.${ADDRESS_PART}$`, "u");

/**
 * The address a prospective customer writes to, from `NEXT_PUBLIC_CONTACT_EMAIL`, or `null`.
 *
 * `null` is the safe default: the page then renders no mail link at all rather than a broken one.
 * The value is checked because it ends up in an `href`: one address, no whitespace, no control
 * characters, no angle brackets or quotes, no `?`, `&`, `#` or `%` that could add a header such as
 * a second recipient, and a dot in the domain.
 *
 * The variable is read through an alias of `process.env` on purpose. A literal
 * `process.env.NEXT_PUBLIC_*` is inlined at build time by Next, which would freeze the value into
 * the image; read through the alias it is the running server's environment, so an operator can set
 * it without rebuilding. (It is also set at build time in the usual way and works the same.)
 */
export function contactEmail(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.NEXT_PUBLIC_CONTACT_EMAIL?.trim();
  if (!raw || raw.length > 254) return null;
  return ADDRESS.test(raw) ? raw : null;
}

/** A `mailto:` link with a subject and a body to start from. */
export function mailtoHref(address: string, subject: string, body: string): string {
  const q = new URLSearchParams({ subject, body }).toString().replace(/\+/g, "%20");
  return `mailto:${address}?${q}`;
}

/**
 * The public origin of this site, for `sitemap.xml` and `robots.txt`.
 *
 * The configured URL wins (`AUTH_URL`, which every deployment already sets for sign-in, then
 * `NEXTAUTH_URL`), so a request cannot choose what the sitemap advertises. Only when neither is
 * set does the request's own `Host` decide, and only if it looks like a host name.
 */
export function publicOrigin(input: {
  env?: Record<string, string | undefined>;
  host?: string | null;
  forwardedProto?: string | null;
}): string {
  const env = input.env ?? process.env;
  for (const key of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    const configured = env[key]?.trim();
    if (!configured) continue;
    try {
      const u = new URL(configured);
      if (u.protocol === "http:" || u.protocol === "https:") return u.origin;
    } catch {
      // Not a URL: try the next source.
    }
  }
  const host = input.host?.trim();
  if (host && /^[a-z0-9.-]+(:\d{1,5})?$/iu.test(host)) {
    const proto = input.forwardedProto === "http" ? "http" : "https";
    return `${proto}://${host}`;
  }
  return "http://localhost:3000";
}
