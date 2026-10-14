"use client";

import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Dialog } from "radix-ui";
import * as React from "react";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { ThemeSwitch } from "@/components/common/ThemeSwitch";
import { Button } from "@/components/ui/button";

export interface LandingHeaderProps {
  appName: string;
  navLabel: string;
  nav: readonly { id: string; label: string }[];
  labels: { menu: string; closeMenu: string };
  /** The visitor's way in: sign in, or the overview when a session exists. */
  signIn: { href: string; label: string };
  /** "Request a workspace" as a mail link, or `null` when no address is configured. */
  request: { href: string; label: string } | null;
}

/**
 * The sticky header of the landing page. Wide screens show the anchors inline; below 1280 px they
 * move into a drawer opened by the menu button. The drawer is a Radix dialog, so it traps focus,
 * closes on Escape, returns focus to the button and marks the page behind it inert. Language and
 * theme sit in the header from 768 px and in the drawer below that; nothing wraps at any width,
 * because each width has its own set of items rather than one set that shrinks.
 */
export function LandingHeader({
  appName,
  navLabel,
  nav,
  labels,
  signIn,
  request,
}: LandingHeaderProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);

  // The drawer has no meaning once the inline navigation is showing: close it on resize.
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 1280px)");
    const close = (): void => {
      if (mq.matches) setOpen(false);
    };
    mq.addEventListener("change", close);
    return () => {
      mq.removeEventListener("change", close);
    };
  }, []);

  const cta = request ?? signIn;
  const ctaIsMail = request !== null;

  return (
    <header className="border-border bg-background/85 supports-[backdrop-filter]:bg-background/70 sticky top-0 z-40 border-b backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-md text-base font-semibold tracking-tight"
        >
          <span
            aria-hidden="true"
            className="bg-brand-gradient text-brand-text grid size-8 place-items-center rounded-lg text-sm font-bold shadow-sm"
          >
            {appName.slice(0, 1).toUpperCase()}
          </span>
          <span>{appName}</span>
        </Link>

        <nav aria-label={navLabel} className="mx-auto hidden items-center gap-1 text-sm xl:flex">
          {nav.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="text-body hover:text-foreground hover:bg-muted rounded-md px-3 py-2 font-medium whitespace-nowrap transition-colors"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 xl:ml-0">
          <LanguageSwitch className="hidden md:flex" />
          <ThemeSwitch compact className="hidden md:inline-flex" />
          {request ? (
            <Button asChild variant="ghost" size="sm" className="hidden lg:inline-flex">
              <Link href={signIn.href}>{signIn.label}</Link>
            </Button>
          ) : null}
          <Button asChild size="sm" className="hidden md:inline-flex">
            {ctaIsMail ? <a href={cta.href}>{cta.label}</a> : <Link href={cta.href}>{cta.label}</Link>}
          </Button>

          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger asChild>
              <Button variant="outline" size="icon" className="xl:hidden" aria-label={labels.menu}>
                <MenuIcon aria-hidden="true" />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="bg-overlay data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none fixed inset-0 z-50 backdrop-blur-[2px]" />
              <Dialog.Content
                aria-describedby={undefined}
                className="bg-card shadow-raised data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right motion-reduce:animate-none fixed inset-y-0 right-0 z-50 flex w-[min(24rem,100vw)] flex-col overflow-y-auto p-5 duration-200"
              >
                <div className="flex items-center justify-between">
                  <Dialog.Title className="text-foreground text-base font-semibold">
                    {labels.menu}
                  </Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="icon" aria-label={labels.closeMenu}>
                      <XIcon aria-hidden="true" />
                    </Button>
                  </Dialog.Close>
                </div>
                <nav aria-label={navLabel} className="mt-4 grid gap-1">
                  {nav.map((item) => (
                    <Dialog.Close asChild key={item.id}>
                      <a
                        href={`#${item.id}`}
                        className="text-foreground hover:bg-muted rounded-lg px-3 py-3 text-lg font-medium"
                      >
                        {item.label}
                      </a>
                    </Dialog.Close>
                  ))}
                </nav>
                <div className="border-border mt-auto grid gap-4 border-t pt-5">
                  <div className="flex items-center justify-between gap-3">
                    <LanguageSwitch id="landing-menu-language" />
                    <ThemeSwitch compact />
                  </div>
                  <Button asChild variant="outline" size="lg">
                    <Link href={signIn.href}>{signIn.label}</Link>
                  </Button>
                  {request ? (
                    <Button asChild size="lg">
                      <a href={request.href}>{request.label}</a>
                    </Button>
                  ) : null}
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>
    </header>
  );
}
