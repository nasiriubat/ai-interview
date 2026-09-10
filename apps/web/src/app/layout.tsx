import type { Metadata, Viewport } from "next";
import * as React from "react";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { getStrings, requestLocale } from "@/i18n/server";
import "./globals.css";

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
    <html lang={locale}>
      <body className="min-h-dvh">
        <LocaleProvider locale={locale}>
          <a
            href="#main"
            className="sr-only sr-only-focusable focus:bg-background focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:border focus:px-3 focus:py-2"
          >
            {t.app.skipToContent}
          </a>
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
