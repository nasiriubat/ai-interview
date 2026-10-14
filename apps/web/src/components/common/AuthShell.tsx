import { CheckIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { ThemeSwitch } from "@/components/common/ThemeSwitch";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/** The product mark: the same tile the landing page and the sidebar use. */
export function BrandMark({ onBrand = false }: { onBrand?: boolean }): React.JSX.Element {
  return (
    <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
      <span
        aria-hidden="true"
        className={cn(
          "grid size-8 place-items-center rounded-lg text-sm font-bold",
          onBrand ? "bg-white/15 text-white ring-1 ring-white/30" : "bg-brand-gradient text-brand-text",
        )}
      >
        D
      </span>
      <span className={onBrand ? "text-white" : "text-foreground"}>{t.app.name}</span>
    </span>
  );
}

/**
 * The frame of the staff-facing standalone pages (D-390): sign-in, the link-sent and error pages,
 * the sign-out confirmation and the global states (not found, forbidden, maintenance, ...).
 *
 * `split` puts the brand panel beside the form from 1024 px up; below it the panel collapses to a
 * compact brand bar so the form is the first thing on a phone. `centered` is one column on the
 * canvas, for states that say one thing. The participant's pages keep `CenteredShell` (D-78): they
 * are the organisation's guests, not the product's own users.
 */
export function AuthShell({
  children,
  variant = "split",
  className,
}: {
  children: React.ReactNode;
  variant?: "split" | "centered";
  className?: string | undefined;
}): React.JSX.Element {
  const b = t.kit.brand;
  const controls = (
    <div className="flex items-center gap-2 print:hidden">
      <ThemeSwitch compact />
      <LanguageSwitch />
    </div>
  );
  if (variant === "centered") {
    return (
      <div className="bg-background flex min-h-dvh flex-col">
        <header className="flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <Link href="/" aria-label={t.app.name} className="rounded-md">
            <BrandMark />
          </Link>
          {controls}
        </header>
        <main id="main" className="flex flex-1 items-center justify-center px-5 pt-4 pb-16">
          <div className={cn("w-full max-w-lg", className)}>{children}</div>
        </main>
      </div>
    );
  }
  return (
    <div className="bg-background grid min-h-dvh lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <aside className="bg-brand-panel relative hidden flex-col justify-between overflow-hidden p-10 text-white lg:flex xl:p-14 print:hidden">
        <div
          aria-hidden="true"
          className="absolute -right-24 -bottom-24 size-[28rem] rounded-full bg-white/[0.06]"
        />
        <div aria-hidden="true" className="absolute -top-20 -left-16 size-72 rounded-full bg-white/[0.05]" />
        <Link href="/" aria-label={t.app.name} className="relative w-fit rounded-md">
          <BrandMark onBrand />
        </Link>
        <div className="relative max-w-md">
          <p className="text-3xl leading-tight font-semibold tracking-tight text-balance xl:text-4xl">
            {b.tagline}
          </p>
          <ul className="mt-8 grid gap-3.5">
            {b.points.map((p) => (
              <li key={p} className="flex items-start gap-3 text-[15px] text-white/90">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-white/15"
                >
                  <CheckIcon className="size-3" />
                </span>
                {p}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-sm text-white/80">{b.footer}</p>
      </aside>
      <div className="flex min-h-dvh flex-col lg:min-h-0">
        <header className="flex items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <Link href="/" aria-label={t.app.name} className="rounded-md lg:invisible lg:pointer-events-none">
            <BrandMark />
          </Link>
          {controls}
        </header>
        <main id="main" className="flex flex-1 items-center justify-center px-5 pt-4 pb-16 sm:px-8">
          <div className={cn("w-full max-w-sm", className)}>{children}</div>
        </main>
      </div>
    </div>
  );
}

/** A heading block for an auth page: optional small eyebrow, title, one line of body. */
export function AuthHeading({
  eyebrow,
  title,
  body,
  children,
}: {
  eyebrow?: string | undefined;
  title: string;
  body?: string | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="grid gap-2">
      {eyebrow ? (
        <p className="text-primary text-xs font-semibold tracking-wide uppercase">{eyebrow}</p>
      ) : null}
      <h1 className="text-foreground text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      {body ? <p className="text-muted-foreground text-sm text-pretty">{body}</p> : null}
      {children}
    </div>
  );
}
