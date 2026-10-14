"use client";

import * as React from "react";
import { t } from "@/i18n";
import type { Branding } from "@/lib/branding-shared";
import { cn } from "@/lib/utils";

const BrandingContext = React.createContext<Branding | null>(null);

/**
 * The platform's name and logo, fetched once per request by the root layout (D-431) and handed to
 * every client component under it. Outside the provider (a unit test, the UI gallery) the bundled
 * name applies, so nothing has to pass it around.
 */
export function BrandingProvider({
  value,
  children,
}: {
  value: Branding;
  children: React.ReactNode;
}): React.JSX.Element {
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): Branding {
  return React.useContext(BrandingContext) ?? { productName: t.app.name, logoUrl: null };
}

/**
 * The product's mark (D-430): the uploaded logo, or the name set in type when there is none.
 * There is no letter tile. The logo's `alt` is the name, so the mark is labelled the same way
 * whichever form it takes, and a link around it needs no `aria-label` of its own.
 *
 * `onBrand` is the white-on-colour variant for the sign-in panel: the name turns white, and a
 * logo sits on a light plate so that a dark or coloured logo stays legible on the brand colour.
 */
export function ProductMark({
  branding,
  onBrand = false,
  className,
}: {
  /** Overrides the context, for a server component that already has the value. */
  branding?: Branding | undefined;
  onBrand?: boolean;
  className?: string | undefined;
}): React.JSX.Element {
  const fromContext = useBranding();
  const { productName, logoUrl } = branding ?? fromContext;
  if (logoUrl) {
    const img = (
      // A same-origin raster of at most 256 KB; next/image would add a loader route for nothing.
      <img
        src={logoUrl}
        alt={productName}
        height={28}
        decoding="async"
        className={cn("block h-7 w-auto max-w-[11rem] object-contain object-left", !onBrand && className)}
      />
    );
    if (!onBrand) return img;
    return (
      <span className={cn("inline-flex rounded-lg bg-white px-2.5 py-1.5 shadow-sm", className)}>{img}</span>
    );
  }
  return (
    <span
      className={cn(
        "block truncate text-[17px] leading-7 font-semibold tracking-tight",
        onBrand ? "text-white" : "text-foreground",
        className,
      )}
    >
      {productName}
    </span>
  );
}
