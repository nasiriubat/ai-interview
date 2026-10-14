"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

const LazyToaster = React.lazy(async () => {
  const m = await import("@/components/ui/sonner");
  return { default: m.Toaster };
});

/**
 * Mounts the toast region on every page except the public landing page (`/`).
 *
 * Sonner injects a `<style>` element when its module is evaluated, and the nonce policy
 * (`style-src 'self' 'nonce-...'`, D-165) reports that element as a violation. Importing Sonner
 * lazily, and not at all where nothing can raise a toast, keeps the landing page free of CSP
 * events. Every other page still loads it, so that violation remains until the library can be given
 * a nonce (it is a report-only event today).
 */
export function ToasterHost(): React.JSX.Element | null {
  const pathname = usePathname();
  if (pathname === "/") return null;
  return (
    <React.Suspense fallback={null}>
      <LazyToaster />
    </React.Suspense>
  );
}
