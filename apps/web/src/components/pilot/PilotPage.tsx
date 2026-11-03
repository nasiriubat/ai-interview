import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { PilotForm } from "./PilotForm";
import { ProductMark } from "@/components/common/Branding";
import { LanguageMenu } from "@/components/common/PreferenceMenus";
import { ThemeToggle } from "@/components/common/ThemeToggle";
import { Button } from "@/components/ui/button";
import type { Strings } from "@/i18n/en";
import type { Branding } from "@/lib/branding-shared";
// The landing page's backdrop (brand glows and the faint grid), imported, not edited, so the two
// pages read as one site.
import "@/components/landing/landing.css";

const container = "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8";

/**
 * The "Request a pilot" page: the product mark and the two preference menus in a slim header, the
 * pitch and what happens next on the left, the form on a card on the right (stacked below 1024 px).
 * A server component: the form is the only client island besides the menus.
 */
export function PilotPage({
  strings: s,
  branding,
}: {
  strings: Strings["pilot"];
  branding: Branding;
}): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex min-h-dvh flex-col">
      <header className="border-border bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 border-b backdrop-blur-md">
        <div className={`${container} flex h-16 items-center gap-3`}>
          <Link href="/" className="flex min-w-0 shrink items-center rounded-md">
            <ProductMark branding={branding} />
          </Link>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <LanguageMenu />
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href="/">
                <ArrowLeftIcon aria-hidden="true" />
                {s.home}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="main" className="relative isolate flex-1 overflow-hidden">
        <div aria-hidden="true" className="lp-hero-bg absolute inset-0 -z-10" />
        <div aria-hidden="true" className="lp-grid absolute inset-0 -z-10" />
        <div
          className={`${container} grid gap-10 pt-10 pb-16 sm:pt-14 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 lg:pt-20 lg:pb-24`}
        >
          <div className="lg:pt-2">
            <p className="text-primary text-sm font-semibold tracking-wide uppercase">{s.eyebrow}</p>
            <h1 className="text-foreground mt-3 text-[2rem] leading-[1.1] font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">
              {s.title}
            </h1>
            <p className="text-body mt-5 max-w-xl text-base leading-relaxed text-pretty sm:text-lg">
              {s.lead(branding.productName)}
            </p>
            <h2 className="text-foreground mt-10 text-sm font-semibold">{s.stepsTitle}</h2>
            <ol className="mt-4 grid max-w-xl gap-4">
              {s.steps.map((step, i) => (
                <li key={step} className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="bg-brand-gradient grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white"
                  >
                    {i + 1}
                  </span>
                  <span className="text-body pt-0.5 text-[15px] leading-relaxed">{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <section
            aria-labelledby="pilot-form-title"
            className="bg-card shadow-raised ring-border relative self-start rounded-2xl p-5 ring-1 sm:p-8"
          >
            <h2 id="pilot-form-title" className="sr-only">
              {s.title}
            </h2>
            <PilotForm />
          </section>
        </div>
      </main>

      <footer className="border-border bg-card border-t">
        <div
          className={`${container} flex flex-col gap-4 py-8 sm:flex-row sm:items-center sm:justify-between`}
        >
          <ProductMark branding={branding} />
          <Link
            href="/"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm"
          >
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {s.home}
          </Link>
        </div>
      </footer>
    </div>
  );
}
