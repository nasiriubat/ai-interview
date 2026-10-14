import { ArrowRightIcon, CheckIcon } from "lucide-react";
import Link from "next/link";
import * as React from "react";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { ThemeSwitch } from "@/components/common/ThemeSwitch";
import { Button } from "@/components/ui/button";
import type { LandingStrings } from "@/i18n/landing.en";
import { mailtoHref } from "@/lib/landing";
import { cn } from "@/lib/utils";

/**
 * The public landing page (`/`). A server component tree with no client JavaScript of its own:
 * the two switches in the header are the only islands, and they are the ones every other page uses.
 * FAQ answers are native `<details>`, so they open without script.
 *
 * It receives its words, the product name and what it needs to know about the visitor as props, so
 * it renders the same in a test as on the server. Nothing here makes a request to another host,
 * loads a font or an image from one, or sets a cookie.
 *
 * Wording lives in `i18n/landing.en.ts` and `landing.fi.ts`; each claim there has a row in
 * `docs/team/claims-2026-10.md`.
 */
export interface LandingProps {
  strings: LandingStrings;
  /** `app.name`: the one place the product's name comes from. */
  appName: string;
  /** A staff session cookie exists: show the way to the overview instead of asking to sign in. */
  signedIn: boolean;
  /** Where "Request a workspace" writes to. `null` renders no mail link. */
  contact: string | null;
}

const container = "mx-auto w-full max-w-5xl px-4 sm:px-6";
const sectionSpacing = "py-12 sm:py-16";
const h2 = "text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl";
const lead = "text-body text-base leading-relaxed sm:text-lg";
const bodyText = "text-body text-[15px] leading-relaxed";

export function Landing({ strings: s, appName, signedIn, contact }: LandingProps): React.JSX.Element {
  const request = contact ? mailtoHref(contact, s.mailto.subject, s.mailto.body) : null;
  return (
    <div className="bg-background text-foreground min-h-dvh">
      <header className="border-border border-b">
        <div className={cn(container, "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3")}>
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-md text-[15px] font-semibold tracking-tight"
          >
            <span
              aria-hidden="true"
              className="bg-brand-gradient text-brand-text grid size-7 place-items-center rounded-md text-xs font-bold shadow-sm"
            >
              {appName.slice(0, 1).toUpperCase()}
            </span>
            <span>{appName}</span>
          </Link>
          <nav aria-label={s.nav.label} className="text-body hidden items-center gap-5 text-sm lg:flex">
            {(
              [
                ["paths", s.nav.paths],
                ["how", s.nav.how],
                ["chatbot", s.nav.chatbot],
                ["trust", s.nav.trust],
                ["faq", s.nav.faq],
              ] as const
            ).map(([id, label]) => (
              <a
                key={id}
                href={`#${id}`}
                className="hover:text-foreground rounded-sm underline-offset-4 hover:underline"
              >
                {label}
              </a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            <ThemeSwitch />
            <Button asChild variant="outline" size="sm">
              <Link href={signedIn ? "/admin" : "/auth/signin"}>
                {signedIn ? s.header.dashboard : s.header.signIn}
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main id="main">
        <section aria-labelledby="hero-title" className="relative overflow-hidden">
          <div aria-hidden="true" className="bg-brand-band absolute inset-x-0 top-0 h-1" />
          <div className={cn(container, "py-14 sm:py-20")}>
            <p className="text-accent-foreground text-sm font-medium">{s.hero.eyebrow}</p>
            <h1
              id="hero-title"
              className="text-foreground mt-3 max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl sm:leading-[1.1]"
            >
              {s.hero.title}
            </h1>
            <p className={cn(lead, "mt-5 max-w-2xl")}>{s.hero.lead}</p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              {signedIn ? (
                <Button asChild size="lg">
                  <Link href="/admin">
                    {s.hero.dashboard}
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </Button>
              ) : (
                <>
                  {request ? (
                    <Button asChild size="lg">
                      <a href={request}>{s.hero.requestWorkspace}</a>
                    </Button>
                  ) : null}
                  <Button asChild size="lg" variant={request ? "outline" : "default"}>
                    <Link href="/auth/signin">{s.hero.signIn}</Link>
                  </Button>
                </>
              )}
            </div>
            {!signedIn && !request ? (
              <p className="text-muted-foreground mt-3 max-w-xl text-sm">{s.hero.noContact}</p>
            ) : null}
            <ul className="text-muted-foreground mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              {s.hero.small.map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <CheckIcon className="text-success size-4 shrink-0" aria-hidden="true" />
                  {line}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section aria-labelledby="participant-title" className={container}>
          <div className="bg-card shadow-card rounded-xl p-5 sm:p-6">
            <h2 id="participant-title" className="text-foreground text-lg font-semibold tracking-tight">
              {s.participant.heading}
            </h2>
            <p className={cn(bodyText, "mt-2 max-w-3xl")}>{s.participant.body}</p>
            <ul className={cn(bodyText, "mt-3 grid list-disc gap-1.5 pl-5")}>
              {s.participant.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </section>

        <section
          id="paths"
          aria-labelledby="paths-title"
          className={cn(container, sectionSpacing, "scroll-mt-4")}
        >
          <h2 id="paths-title" className={h2}>
            {s.paths.heading}
          </h2>
          <p className={cn(lead, "mt-3 max-w-2xl")}>{s.paths.intro}</p>
          <div className="mt-8 grid gap-5 lg:grid-cols-2">
            <PathCard path={s.paths.discovery} />
            <PathCard path={s.paths.requirements} />
          </div>
          <div className="bg-accent mt-5 rounded-xl p-5 sm:p-6">
            <p className="text-accent-foreground text-xs font-semibold tracking-wide uppercase">
              {s.paths.bridge.kicker}
            </p>
            <h3 className="text-foreground mt-1 text-lg font-semibold tracking-tight">
              {s.paths.bridge.title}
            </h3>
            <p className={cn(bodyText, "mt-2 max-w-3xl")}>{s.paths.bridge.body}</p>
          </div>
        </section>

        <section
          id="how"
          aria-labelledby="how-title"
          className={cn(container, sectionSpacing, "scroll-mt-4")}
        >
          <h2 id="how-title" className={h2}>
            {s.how.heading}
          </h2>
          <div className="mt-8 grid gap-10 lg:grid-cols-2">
            <Steps title={s.how.discovery.title} steps={s.how.discovery.steps} />
            <Steps title={s.how.requirements.title} steps={s.how.requirements.steps} />
          </div>
        </section>

        <section
          id="chatbot"
          aria-labelledby="chatbot-title"
          className={cn(container, sectionSpacing, "scroll-mt-4")}
        >
          <h2 id="chatbot-title" className={h2}>
            {s.chatbot.heading}
          </h2>
          <p className={cn(lead, "mt-3 max-w-2xl")}>{s.chatbot.intro}</p>
          <div className="bg-card shadow-card mt-8 overflow-hidden rounded-xl">
            <table className="w-full table-fixed border-collapse text-left text-sm">
              <caption className="sr-only">{s.chatbot.tableCaption}</caption>
              <thead>
                <tr className="bg-muted">
                  <th scope="col" className="text-muted-foreground w-1/2 px-3 py-3 font-medium sm:px-5">
                    {s.chatbot.columnChat}
                  </th>
                  <th scope="col" className="text-foreground w-1/2 px-3 py-3 font-semibold sm:px-5">
                    {s.chatbot.columnHere}
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.chatbot.rows.map((row) => (
                  <tr key={row.chat} className="border-border border-t align-top">
                    <td className="text-muted-foreground px-3 py-4 leading-relaxed [overflow-wrap:anywhere] sm:px-5">
                      {row.chat}
                    </td>
                    <td className="text-foreground px-3 py-4 leading-relaxed [overflow-wrap:anywhere] sm:px-5">
                      {row.here}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-8 max-w-3xl">
            <h3 className="text-foreground text-lg font-semibold tracking-tight">
              {s.chatbot.justAsWellHeading}
            </h3>
            <p className={cn(bodyText, "mt-2")}>{s.chatbot.justAsWell}</p>
          </div>
        </section>

        <section
          id="trust"
          aria-labelledby="trust-title"
          className={cn(container, sectionSpacing, "scroll-mt-4")}
        >
          <h2 id="trust-title" className={h2}>
            {s.trust.heading}
          </h2>
          <p className={cn(lead, "mt-3 max-w-2xl")}>{s.trust.intro}</p>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            {s.trust.items.map((item) => (
              <article key={item.title} className="bg-card shadow-card rounded-xl p-5 sm:p-6">
                <h3 className="text-foreground text-lg font-semibold tracking-tight">{item.title}</h3>
                <p className={cn(bodyText, "mt-2")}>{item.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="audience-title" className={cn(container, sectionSpacing)}>
          <h2 id="audience-title" className={h2}>
            {s.audience.heading}
          </h2>
          <ul className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {s.audience.items.map((item) => (
              <li key={item.title}>
                <h3 className="text-foreground text-base font-semibold">{item.title}</h3>
                <p className={cn(bodyText, "mt-1")}>{item.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section
          id="faq"
          aria-labelledby="faq-title"
          className={cn(container, sectionSpacing, "scroll-mt-4")}
        >
          <h2 id="faq-title" className={h2}>
            {s.faq.heading}
          </h2>
          <div className="mt-8 max-w-3xl">
            {s.faq.items.map((item) => (
              <details key={item.q} className="border-border group border-b py-4 first:border-t">
                <summary className="text-foreground flex cursor-pointer list-none items-start justify-between gap-4 text-base font-medium [&::-webkit-details-marker]:hidden">
                  <span>{item.q}</span>
                  <span
                    aria-hidden="true"
                    className="text-muted-foreground mt-0.5 text-lg leading-none transition-transform group-open:rotate-45"
                  >
                    +
                  </span>
                </summary>
                <p className={cn(bodyText, "mt-3")}>{item.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="cta-title" className={cn(container, "pb-16 sm:pb-24")}>
          <div className="bg-card shadow-raised rounded-2xl p-6 sm:p-10">
            <h2 id="cta-title" className={h2}>
              {s.cta.heading}
            </h2>
            <p className={cn(lead, "mt-3 max-w-2xl")}>{s.cta.body}</p>
            <div className="mt-6 flex flex-wrap items-center gap-3">
              {signedIn ? (
                <Button asChild size="lg">
                  <Link href="/admin">{s.cta.dashboard}</Link>
                </Button>
              ) : (
                <>
                  {request ? (
                    <Button asChild size="lg">
                      <a href={request}>{s.cta.request}</a>
                    </Button>
                  ) : null}
                  <Button asChild size="lg" variant={request ? "outline" : "default"}>
                    <Link href="/auth/signin">{s.cta.signIn}</Link>
                  </Button>
                </>
              )}
            </div>
            <p className="text-muted-foreground mt-6 max-w-2xl text-sm">{s.cta.consultancy}</p>
          </div>
        </section>
      </main>

      <footer className="border-border border-t">
        <div
          className={cn(
            container,
            "text-muted-foreground flex flex-wrap items-center justify-between gap-3 py-6 text-sm",
          )}
        >
          <p className="max-w-xl">
            <span className="text-foreground font-medium">{appName}</span>. {s.footer.note}
          </p>
          <Link
            href={signedIn ? "/admin" : "/auth/signin"}
            className="text-accent-foreground underline underline-offset-4"
          >
            {signedIn ? s.header.dashboard : s.footer.signIn}
          </Link>
        </div>
      </footer>
    </div>
  );
}

function PathCard({ path }: { path: LandingStrings["paths"]["discovery"] }): React.JSX.Element {
  return (
    <article className="bg-card shadow-card rounded-xl p-5 sm:p-6">
      <p className="text-accent-foreground text-xs font-semibold tracking-wide uppercase">{path.kicker}</p>
      <h3 className="text-foreground mt-1 text-xl font-semibold tracking-tight text-balance">{path.title}</h3>
      <p className="text-muted-foreground mt-1 text-sm">{path.audience}</p>
      <div className="mt-4 grid gap-3">
        {path.paragraphs.map((p) => (
          <p key={p} className={bodyText}>
            {p}
          </p>
        ))}
      </div>
    </article>
  );
}

function Steps({
  title,
  steps,
}: {
  title: string;
  steps: LandingStrings["how"]["discovery"]["steps"];
}): React.JSX.Element {
  return (
    <div>
      <h3 className="text-foreground text-lg font-semibold tracking-tight">{title}</h3>
      <ol className="mt-5 grid gap-5">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="bg-accent text-accent-foreground grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold"
            >
              {i + 1}
            </span>
            <div>
              <h4 className="text-foreground text-base font-semibold">{step.title}</h4>
              <p className={cn(bodyText, "mt-1")}>{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
