import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import * as React from "react";
import { NavigationProgress } from "@/components/common/NavigationProgress";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { getStrings, requestLocale } from "@/i18n/server";
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
  return (
    <html lang={locale} className={inter.variable}>
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
          <Toaster />
        </LocaleProvider>
      </body>
    </html>
  );
}
