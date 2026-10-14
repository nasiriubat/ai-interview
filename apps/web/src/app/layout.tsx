import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { headers } from "next/headers";
import * as React from "react";
import { NavigationProgress } from "@/components/common/NavigationProgress";
import { OfflineBanner } from "@/components/common/OfflineBanner";
import { ToasterHost } from "@/components/common/ToasterHost";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { getStrings, requestLocale } from "@/i18n/server";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import "./globals.css";

// Self-hosted at build time by next/font: the browser never contacts Google, which matters for an
// EU product whose participants have not consented to a third-party request just to load a page.
const inter = Inter({ subsets: ["latin", "latin-ext"], display: "swap", variable: "--font-inter" });

export async function generateMetadata(): Promise<Metadata> {
  const t = await getStrings();
  return {
    title: { default: t.app.name, template: `%s · ${t.app.name}` },
    description: t.app.description,
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const locale = await requestLocale();
  const t = await getStrings();
  // Set by proxy.ts for this request (D-165). Read by MermaidDiagram, whose SVG carries a <style>
  // element that a nonce-only style-src would otherwise refuse.
  const nonce = (await headers()).get("x-nonce") ?? "";
  return (
    // `data-theme` is set on <html> by the script below before React runs; React must not
    // object that the attribute is not in the markup it rendered.
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <head>
        {nonce ? <meta name="csp-nonce" content={nonce} /> : null}
        {/* react-style-singleton, under Radix dialogs and popovers, creates a <style> element and
            gives it the nonce it finds in this global. Without it every dialog is a style-src
            violation (found by the Playwright CSP assertion, D-264). */}
        {nonce ? (
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{ __html: `window.__webpack_nonce__=${JSON.stringify(nonce)};` }}
          />
        ) : null}
        <script nonce={nonce || undefined} dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-dvh">
        <LocaleProvider locale={locale}>
          <React.Suspense fallback={null}>
            <NavigationProgress />
          </React.Suspense>
          <a
            href="#main"
            className="sr-only sr-only-focusable focus:bg-background focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:border focus:px-3 focus:py-2"
          >
            {t.app.skipToContent}
          </a>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
          <ToasterHost />
          <OfflineBanner />
        </LocaleProvider>
      </body>
    </html>
  );
}
