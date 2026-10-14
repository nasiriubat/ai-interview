import * as React from "react";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * The frame of every page that is one card in the middle of the screen: sign-in, the participant's
 * arrival and consent steps, and status pages (D-78). A slanted gradient band behind the card, the
 * brand in its top-left corner. The band is decoration (`aria-hidden`); the brand sits over its
 * indigo end, where white text keeps 4.7:1, never over the cyan end, where it would not.
 */
export function CenteredShell({
  children,
  aside,
  card = true,
  className,
}: {
  children: React.ReactNode;
  /** Top-right controls, such as the language switch. */
  aside?: React.ReactNode;
  /** False for content that brings its own surface. */
  card?: boolean;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className="bg-background relative flex min-h-dvh flex-col overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 -top-40 h-[26rem] origin-top-left -skew-y-6 bg-brand-band print:hidden"
      />
      <header className="relative flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
        <span className="text-[17px] font-semibold tracking-tight text-white">{t.app.name}</span>
        {aside ? <div className="rounded-md bg-white/90 px-1.5 py-1 shadow-sm">{aside}</div> : null}
      </header>
      <main
        id="main"
        className="relative flex flex-1 items-start justify-center px-4 pt-6 pb-10 sm:items-center sm:pt-0"
      >
        <div
          className={cn("w-full max-w-md", card && "bg-card shadow-raised rounded-xl p-6 sm:p-8", className)}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
