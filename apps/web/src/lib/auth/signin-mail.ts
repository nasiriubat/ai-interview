/**
 * The staff sign-in email (simulation 2026-10-15). Auth.js's default is titled "Sign in to
 * <host>", names no product and says nothing about how long the link lasts, which reads like
 * phishing on a fresh install. This one names the product, says what the link does, that it works
 * once and for how long, and what to do if the person did not ask for it.
 *
 * Pure and dependency-free so it is tested without NextAuth or a mail server.
 */

export type SignInMailLocale = "en" | "fi";

export interface SignInMail {
  subject: string;
  text: string;
  html: string;
}

/** Auth.js's email provider default, in hours (`maxAge` 24 h). */
export const SIGN_IN_LINK_HOURS = 24;

const COPY = {
  en: {
    subject: (product: string) => `Your sign-in link for ${product}`,
    intro: (product: string) => `Use this link to sign in to ${product}:`,
    button: "Sign in",
    once: (hours: number) => `The link works once and expires in ${hours} hours.`,
    ignore: "If you did not ask to sign in, you can ignore this email; nobody can sign in without the link.",
  },
  fi: {
    subject: (product: string) => `Kirjautumislinkkisi palveluun ${product}`,
    intro: (product: string) => `Kirjaudu palveluun ${product} tällä linkillä:`,
    button: "Kirjaudu sisään",
    once: (hours: number) => `Linkki toimii kerran ja vanhenee ${hours} tunnin kuluttua.`,
    ignore:
      "Jos et pyytänyt kirjautumista, voit jättää tämän viestin huomiotta; kukaan ei voi kirjautua ilman linkkiä.",
  },
} as const;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The language of the request that asked for the link: the `lang` cookie, then Accept-Language. */
export function signInMailLocale(
  headers: { get(name: string): string | null } | undefined,
): SignInMailLocale {
  const cookie = headers?.get("cookie") ?? "";
  const lang = /(?:^|;\s*)lang=([a-z]{2})/i.exec(cookie)?.[1]?.toLowerCase();
  if (lang === "fi" || lang === "en") return lang;
  return /^fi\b/i.test(headers?.get("accept-language") ?? "") ? "fi" : "en";
}

export function signInMessage(input: {
  url: string;
  productName: string;
  locale: SignInMailLocale;
  hours?: number;
}): SignInMail {
  const c = COPY[input.locale];
  const product = input.productName.trim() || "Discovery";
  const hours = input.hours ?? SIGN_IN_LINK_HOURS;
  const text = [c.intro(product), "", input.url, "", c.once(hours), c.ignore, ""].join("\n");
  const p = escapeHtml(product);
  const href = escapeHtml(input.url);
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;line-height:1.5;margin:0;padding:24px;background:#f8fafc">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="font-size:18px;font-weight:600;margin:0 0 16px">${p}</p>
<p style="margin:0 0 20px">${escapeHtml(c.intro(product))}</p>
<p style="margin:0 0 20px"><a href="${href}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">${escapeHtml(c.button)}</a></p>
<p style="margin:0 0 8px;color:#475569;font-size:14px">${escapeHtml(c.once(hours))}</p>
<p style="margin:0;color:#475569;font-size:14px">${escapeHtml(c.ignore)}</p>
</div></body></html>`;
  return { subject: c.subject(product), text, html };
}
