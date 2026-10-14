import {
  ArrowDownIcon,
  ArrowRightIcon,
  BriefcaseBusinessIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  CodeXmlIcon,
  CoinsIcon,
  CompassIcon,
  DatabaseIcon,
  EyeOffIcon,
  FileDownIcon,
  LandmarkIcon,
  LayersIcon,
  LightbulbIcon,
  LockKeyholeIcon,
  MessagesSquareIcon,
  PlusIcon,
  RouteIcon,
  SendIcon,
  ServerIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UsersRoundIcon,
  XIcon,
  ListChecksIcon,
  type LucideIcon,
  UserCheckIcon,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import * as React from "react";
import { LandingHeader } from "./LandingHeader";
import { LanguageSwitch } from "@/components/common/LanguageSwitch";
import { Button } from "@/components/ui/button";
import type { LandingStrings } from "@/i18n/landing.en";
import { mailtoHref } from "@/lib/landing";
import { cn } from "@/lib/utils";
import "./landing.css";

/**
 * The public landing page (`/`). A server component tree: the header's menu and the two switches
 * are the only client islands, and they are the ones every other page uses. FAQ answers are native
 * `<details>`, so they open without script. Screenshots are static files from `public/landing/`
 * (cropped, resized and re-encoded from `marketing/demo-2026-10`), served from the same origin with
 * their width and height, so nothing shifts and nothing is requested from another host.
 *
 * It receives its words, the product name and what it needs to know about the visitor as props, so
 * it renders the same in a test as on the server. Wording lives in `i18n/landing.en.ts` and
 * `landing.fi.ts`; each claim there has a row in `docs/team/claims-2026-10.md`.
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

const container = "mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8";
const bodyText = "text-body text-[15px] leading-relaxed";
const SECURITY_TXT = "/.well-known/security.txt";

const IMG = {
  results: { light: "/landing/results-light.webp", dark: "/landing/results-dark.webp", w: 1400, h: 875 },
  workspace: {
    light: "/landing/workspace-light.webp",
    dark: "/landing/workspace-dark.webp",
    w: 1400,
    h: 875,
  },
  phone: { src: "/landing/interview-phone.webp", w: 520, h: 1125 },
  gallery: [
    { src: "/landing/opportunities.webp", w: 1200, h: 750 },
    { src: "/landing/evidence.webp", w: 1200, h: 750 },
    { src: "/landing/spec.webp", w: 1200, h: 750 },
    { src: "/landing/diagram.webp", w: 1200, h: 446 },
  ],
} as const;

export function Landing({ strings: s, appName, signedIn, contact }: LandingProps): React.JSX.Element {
  const request = contact ? mailtoHref(contact, s.mailto.subject, s.mailto.body) : null;
  const signInHref = signedIn ? "/admin" : "/auth/signin";
  const signInLabel = signedIn ? s.header.dashboard : s.header.signIn;
  const nav = [
    { id: "paths", label: s.nav.paths },
    { id: "how", label: s.nav.how },
    { id: "results", label: s.nav.results },
    { id: "chatbot", label: s.nav.chatbot },
    { id: "trust", label: s.nav.trust },
    { id: "faq", label: s.nav.faq },
  ] as const;

  return (
    <div className="bg-background text-foreground min-h-dvh">
      <LandingHeader
        appName={appName}
        navLabel={s.nav.label}
        nav={nav}
        labels={{ menu: s.header.menu, closeMenu: s.header.closeMenu }}
        signIn={{ href: signInHref, label: signInLabel }}
        request={signedIn || !request ? null : { href: request, label: s.hero.requestWorkspace }}
      />

      <main id="main">
        {/* Hero */}
        <section aria-labelledby="hero-title" className="relative isolate overflow-hidden">
          <div aria-hidden="true" className="lp-hero-bg absolute inset-0 -z-10" />
          <div aria-hidden="true" className="lp-grid absolute inset-0 -z-10" />
          <div className={cn(container, "pt-14 pb-16 text-center sm:pt-20 lg:pt-24")}>
            <p className="border-border bg-card/80 text-accent-foreground lp-rise mx-auto inline-flex max-w-full items-start gap-2 rounded-2xl ring-1 ring-border px-3.5 py-1.5 text-left text-[13px] leading-snug font-medium">
              <span aria-hidden="true" className="bg-brand-gradient mt-1.5 size-2 shrink-0 rounded-full" />
              <span className="text-balance">{s.hero.eyebrow}</span>
            </p>
            <h1
              id="hero-title"
              className="text-foreground lp-rise mx-auto mt-6 max-w-4xl text-[2rem] leading-[1.1] font-semibold tracking-tight text-balance min-[420px]:text-4xl sm:text-5xl lg:text-6xl"
            >
              {s.hero.title}
            </h1>
            <p className="text-body lp-rise-2 mx-auto mt-6 max-w-2xl text-base leading-relaxed text-pretty sm:text-lg">
              {s.hero.lead}
            </p>
            <div className="lp-rise-2 mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
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
                      <a href={request}>
                        {s.hero.requestWorkspace}
                        <ArrowRightIcon aria-hidden="true" />
                      </a>
                    </Button>
                  ) : null}
                  <Button asChild size="lg" variant={request ? "outline" : "default"}>
                    <Link href="/auth/signin">{s.hero.signIn}</Link>
                  </Button>
                </>
              )}
            </div>
            {!signedIn && !request ? (
              <p className="text-muted-foreground mx-auto mt-4 max-w-xl text-sm">{s.hero.noContact}</p>
            ) : null}
            <ul className="text-body mx-auto mt-8 flex max-w-3xl flex-col items-center gap-x-6 gap-y-2.5 text-sm sm:flex-row sm:flex-wrap sm:justify-center">
              {s.hero.small.map((line) => (
                <li key={line} className="flex items-center gap-2">
                  <span className="bg-success-soft text-success-soft-foreground grid size-5 shrink-0 place-items-center rounded-full">
                    <CheckIcon className="size-3" aria-hidden="true" strokeWidth={3} />
                  </span>
                  {line}
                </li>
              ))}
            </ul>

            <div className="relative mx-auto mt-14 max-w-5xl sm:mt-16">
              <div className="lp-rise-2">
                <div className="lp-window hidden text-left sm:block">
                  <div className="lp-window-bar" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </div>
                  <ThemedShot
                    light={IMG.results.light}
                    dark={IMG.results.dark}
                    width={IMG.results.w}
                    height={IMG.results.h}
                    alt={s.hero.visualAlt}
                    priority
                    sizes="(min-width: 1024px) 1024px, 100vw"
                  />
                </div>
              </div>
              <div className="mx-auto w-56 sm:absolute sm:-right-1 sm:-bottom-10 sm:w-[18%] sm:min-w-32 lg:-right-6">
                <div className="lp-float">
                  <div className="lp-phone">
                    <Image
                      src={IMG.phone.src}
                      width={IMG.phone.w}
                      height={IMG.phone.h}
                      alt={s.hero.phoneAlt}
                      sizes="220px"
                      unoptimized
                      className="h-auto w-full"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Participant strip */}
        <section aria-labelledby="participant-title" className={cn(container, "mt-10 sm:mt-16")}>
          <div className="border-border bg-accent/60 grid gap-6 rounded-2xl ring-1 ring-border p-6 sm:p-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
            <div className="flex gap-4">
              <span className="bg-card text-accent-foreground shadow-card grid size-11 shrink-0 place-items-center rounded-xl">
                <UserCheckIcon className="size-5" aria-hidden="true" />
              </span>
              <div>
                <h2
                  id="participant-title"
                  className="text-foreground text-xl font-semibold tracking-tight text-balance"
                >
                  {s.participant.heading}
                </h2>
                <p className={cn(bodyText, "mt-2")}>{s.participant.body}</p>
              </div>
            </div>
            <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              {s.participant.points.map((p) => (
                <li
                  key={p}
                  className="bg-card text-body shadow-card flex gap-3 rounded-xl p-4 text-sm leading-relaxed"
                >
                  <CheckIcon className="text-success mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Two interviews and the bridge */}
        <Section
          id="paths"
          eyebrow={s.nav.paths}
          title={s.paths.heading}
          intro={s.paths.intro}
          icon={RouteIcon}
        >
          <div className="mt-12 grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-0">
            <PathCard path={s.paths.discovery} icon={CompassIcon} />
            <div className="relative flex flex-col items-center justify-center lg:flex-row">
              <span
                aria-hidden="true"
                className="border-border absolute inset-y-0 left-1/2 border-l-2 border-dashed lg:inset-x-0 lg:inset-y-auto lg:top-1/2 lg:left-0 lg:border-t-2 lg:border-l-0"
              />
              <Connector />
              <div className="from-primary/90 to-chart-2 relative z-10 w-full max-w-md rounded-2xl bg-gradient-to-br p-px lg:w-64">
                <div className="bg-card h-full rounded-[15px] p-5 text-center">
                  <span className="bg-accent text-accent-foreground mx-auto grid size-10 place-items-center rounded-full">
                    <RouteIcon className="size-5" aria-hidden="true" />
                  </span>
                  <p className="text-accent-foreground mt-3 text-xs font-semibold tracking-wide uppercase">
                    {s.paths.bridge.kicker}
                  </p>
                  <h3 className="text-foreground mt-1 text-base leading-snug font-semibold text-balance">
                    {s.paths.bridge.title}
                  </h3>
                  <p className="text-body mt-2 text-sm leading-relaxed">{s.paths.bridge.body}</p>
                </div>
              </div>
              <Connector />
            </div>
            <PathCard path={s.paths.requirements} icon={LightbulbIcon} />
          </div>
        </Section>

        {/* How it works */}
        <Section id="how" band eyebrow={s.nav.how} title={s.how.heading} icon={ListChecksIcon}>
          <div className="mt-12 grid gap-12 lg:grid-cols-2 lg:gap-10 xl:gap-16">
            <Lane
              title={s.how.discovery.title}
              steps={s.how.discovery.steps}
              icons={[SlidersHorizontalIcon, SendIcon, MessagesSquareIcon, ChartNoAxesColumnIcon]}
              visual={
                <div className="from-accent to-muted border-border relative overflow-hidden rounded-2xl ring-1 ring-border bg-gradient-to-br px-6 pt-6">
                  <div className="lp-phone mx-auto w-[min(15rem,70%)] rounded-b-none">
                    <Image
                      src={IMG.phone.src}
                      width={IMG.phone.w}
                      height={IMG.phone.h}
                      alt={s.how.discovery.visualAlt}
                      sizes="240px"
                      loading="lazy"
                      unoptimized
                      className="h-auto max-h-[22rem] w-full rounded-b-none object-cover object-top"
                    />
                  </div>
                </div>
              }
            />
            <Lane
              title={s.how.requirements.title}
              steps={s.how.requirements.steps}
              icons={[LightbulbIcon, LayersIcon, UsersRoundIcon, FileDownIcon]}
              visual={
                <div className="from-accent to-muted border-border relative overflow-hidden rounded-2xl ring-1 ring-border bg-gradient-to-br px-5 pt-5 sm:px-8 sm:pt-8">
                  <div className="lp-window rounded-b-none text-left">
                    <ThemedShot
                      light={IMG.workspace.light}
                      dark={IMG.workspace.dark}
                      width={IMG.workspace.w}
                      height={IMG.workspace.h}
                      alt={s.how.requirements.visualAlt}
                      sizes="(min-width: 1024px) 560px, 100vw"
                      className="max-h-[22rem] object-cover object-top"
                    />
                  </div>
                </div>
              }
            />
          </div>
        </Section>

        {/* Results gallery */}
        <Section
          id="results"
          eyebrow={s.nav.results}
          title={s.gallery.heading}
          intro={s.gallery.intro}
          icon={ChartNoAxesColumnIcon}
        >
          <div className="mt-12 grid gap-5 lg:grid-cols-6">
            {s.gallery.items.map((item, i) => {
              const img = IMG.gallery[i];
              if (!img) return null;
              const span = ["lg:col-span-3", "lg:col-span-3", "lg:col-span-2", "lg:col-span-4"][i];
              return (
                <figure
                  key={item.title}
                  className={cn(
                    "bg-card shadow-card lp-lift flex flex-col overflow-hidden rounded-2xl",
                    span,
                  )}
                >
                  <div className="border-border bg-muted border-b">
                    <Image
                      src={img.src}
                      width={img.w}
                      height={img.h}
                      alt={item.alt}
                      sizes="(min-width: 1280px) 600px, (min-width: 1024px) 50vw, 100vw"
                      unoptimized
                      className="h-auto w-full"
                    />
                  </div>
                  <figcaption className="p-5 sm:p-6">
                    <h3 className="text-foreground text-lg font-semibold tracking-tight">{item.title}</h3>
                    <p className={cn(bodyText, "mt-2")}>{item.body}</p>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </Section>

        {/* Why not a chatbot */}
        <Section
          id="chatbot"
          band
          eyebrow={s.nav.chatbot}
          title={s.chatbot.heading}
          intro={s.chatbot.intro}
          icon={MessagesSquareIcon}
        >
          <div className="mt-12">
            <div
              aria-hidden="true"
              className="text-muted-foreground mb-3 hidden grid-cols-2 px-0 text-xs font-semibold tracking-wide uppercase md:grid"
            >
              <span className="pl-[3.25rem]">{s.chatbot.columnChat}</span>
              <span className="text-accent-foreground pl-[3.25rem]">{s.chatbot.columnHere}</span>
            </div>
            <ul aria-label={s.chatbot.tableCaption} className="grid gap-3">
              {s.chatbot.rows.map((row) => (
                <li
                  key={row.chat}
                  className="bg-card shadow-card grid overflow-hidden rounded-xl md:grid-cols-2"
                >
                  <div className="text-muted-foreground flex gap-3 p-5 text-[15px] leading-relaxed md:px-6">
                    <XIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div>
                      <span className="mb-1 block text-xs font-semibold tracking-wide uppercase md:sr-only">
                        {s.chatbot.columnChat}
                      </span>
                      {row.chat}
                    </div>
                  </div>
                  <div className="bg-accent/60 text-foreground flex gap-3 p-5 text-[15px] leading-relaxed md:px-6">
                    <CheckIcon className="text-success mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <div>
                      <span className="text-accent-foreground mb-1 block text-xs font-semibold tracking-wide uppercase md:sr-only">
                        {s.chatbot.columnHere}
                      </span>
                      {row.here}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            <div className="bg-card outline-border mt-8 rounded-2xl outline-1 -outline-offset-1 outline-dashed p-6 sm:p-8">
              <h3 className="text-foreground text-lg font-semibold tracking-tight">
                {s.chatbot.justAsWellHeading}
              </h3>
              <p className={cn(bodyText, "mt-2 max-w-4xl")}>{s.chatbot.justAsWell}</p>
            </div>
          </div>
        </Section>

        {/* Trust */}
        <Section
          id="trust"
          eyebrow={s.nav.trust}
          title={s.trust.heading}
          intro={s.trust.intro}
          icon={ShieldCheckIcon}
        >
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-6">
            {s.trust.items.map((item, i) => {
              const Icon =
                [LockKeyholeIcon, EyeOffIcon, ServerIcon, DatabaseIcon, CoinsIcon][i] ?? ShieldCheckIcon;
              const span = i < 3 ? "lg:col-span-2" : "lg:col-span-3";
              return (
                <article key={item.title} className={cn("bg-card shadow-card lp-lift rounded-2xl p-6", span)}>
                  <span className="bg-accent text-accent-foreground grid size-11 place-items-center rounded-xl">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="text-foreground mt-5 text-lg font-semibold tracking-tight">{item.title}</h3>
                  <p className={cn(bodyText, "mt-2")}>{item.body}</p>
                </article>
              );
            })}
          </div>
        </Section>

        {/* Audience */}
        <Section
          id="audience"
          band
          eyebrow={s.audience.heading}
          title={s.audience.heading}
          icon={UsersRoundIcon}
        >
          <ul className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-6">
            {s.audience.items.map((item, i) => {
              const Icon =
                [BriefcaseBusinessIcon, LandmarkIcon, CompassIcon, LightbulbIcon, CodeXmlIcon][i] ??
                UsersRoundIcon;
              return (
                <li
                  key={item.title}
                  className={cn(
                    "bg-card shadow-card flex gap-4 rounded-2xl p-5 sm:p-6",
                    i < 3 ? "lg:col-span-2" : "lg:col-span-3",
                  )}
                >
                  <span className="bg-accent text-accent-foreground grid size-10 shrink-0 place-items-center rounded-lg">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-foreground text-base font-semibold">{item.title}</h3>
                    <p className={cn(bodyText, "mt-1")}>{item.body}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* FAQ */}
        <section id="faq" aria-labelledby="faq-title" className={cn(container, "lp-anchor py-16 sm:py-24")}>
          <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-16">
            <div className="lg:sticky lg:top-24 lg:self-start">
              <p className="text-accent-foreground text-sm font-semibold tracking-wide uppercase">
                {s.nav.faq}
              </p>
              <h2
                id="faq-title"
                className="text-foreground mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
              >
                {s.faq.heading}
              </h2>
            </div>
            <div className="lp-faq grid gap-3">
              {s.faq.items.map((item) => (
                <details
                  key={item.q}
                  name="faq"
                  className="bg-card shadow-card group open:shadow-raised rounded-xl transition-shadow"
                >
                  <summary className="text-foreground flex cursor-pointer list-none items-start justify-between gap-4 rounded-xl px-5 py-4 text-base font-medium">
                    <span className="text-balance">{item.q}</span>
                    <span className="bg-muted text-muted-foreground mt-0.5 grid size-6 shrink-0 place-items-center rounded-full transition-transform group-open:rotate-45">
                      <PlusIcon className="size-3.5" aria-hidden="true" />
                    </span>
                  </summary>
                  <p className={cn(bodyText, "px-5 pb-5")}>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* Closing call to action */}
        <section aria-labelledby="cta-title" className={cn(container, "pb-16 sm:pb-24")}>
          <div className="lp-cta shadow-raised overflow-hidden rounded-3xl px-6 py-12 text-center sm:px-12 sm:py-16">
            <h2
              id="cta-title"
              className="mx-auto max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
            >
              {s.cta.heading}
            </h2>
            <p className="lp-cta-lead mx-auto mt-4 max-w-2xl text-base leading-relaxed text-pretty sm:text-lg">
              {s.cta.body}
            </p>
            <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
              {signedIn ? (
                <a href="/admin" className="lp-cta-btn">
                  {s.cta.dashboard}
                </a>
              ) : (
                <>
                  {request ? (
                    <a href={request} className="lp-cta-btn">
                      {s.cta.request}
                    </a>
                  ) : null}
                  <Link href="/auth/signin" className={cn(request ? "lp-cta-btn-ghost" : "lp-cta-btn")}>
                    {s.cta.signIn}
                  </Link>
                </>
              )}
            </div>
            <p className="lp-cta-lead mx-auto mt-8 max-w-2xl text-sm leading-relaxed">{s.cta.consultancy}</p>
          </div>
        </section>
      </main>

      <footer className="border-border bg-card border-t">
        <div className={cn(container, "py-12")}>
          <div className="grid gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <div>
              <p className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
                <span
                  aria-hidden="true"
                  className="bg-brand-gradient text-brand-text grid size-8 place-items-center rounded-lg text-sm font-bold"
                >
                  {appName.slice(0, 1).toUpperCase()}
                </span>
                <span>{appName}</span>
              </p>
              <p className="text-muted-foreground mt-4 max-w-sm text-sm leading-relaxed">{s.footer.note}</p>
            </div>
            <nav aria-label={s.footer.navLabel} className="grid gap-8 sm:grid-cols-3">
              <FooterColumn title={s.footer.product}>
                {nav.map((item) => (
                  <li key={item.id}>
                    <a href={`#${item.id}`}>{item.label}</a>
                  </li>
                ))}
              </FooterColumn>
              <FooterColumn title={s.footer.access}>
                <li>
                  <Link href={signInHref}>{signedIn ? s.header.dashboard : s.footer.signIn}</Link>
                </li>
                {request && !signedIn ? (
                  <li>
                    <a href={request}>{s.hero.requestWorkspace}</a>
                  </li>
                ) : null}
              </FooterColumn>
              <FooterColumn title={s.footer.trust}>
                <li>
                  <a href="#trust">{s.footer.privacy}</a>
                </li>
                {request && !signedIn ? (
                  <li>
                    <a href={request}>{s.footer.contact}</a>
                  </li>
                ) : null}
                <li>
                  <a href={SECURITY_TXT}>{s.footer.security}</a>
                </li>
              </FooterColumn>
            </nav>
          </div>
          <div className="border-border mt-10 flex items-center justify-between gap-4 border-t pt-6">
            <span className="text-muted-foreground text-sm">{s.footer.language}</span>
            <LanguageSwitch id="landing-footer-language" />
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({
  id,
  eyebrow,
  title,
  intro,
  icon: Icon,
  band = false,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  intro?: string;
  icon: LucideIcon;
  band?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={cn("lp-anchor py-16 sm:py-24", band && "bg-muted/60 border-border border-y")}
    >
      <div className={container}>
        <div className="mx-auto max-w-3xl text-center">
          {eyebrow.toLowerCase() === title.toLowerCase() ? (
            <span className="bg-accent text-accent-foreground mx-auto grid size-11 place-items-center rounded-xl">
              <Icon className="size-5" aria-hidden="true" />
            </span>
          ) : (
            <p className="text-accent-foreground inline-flex items-center gap-2 text-sm font-semibold tracking-wide uppercase">
              <Icon className="size-4" aria-hidden="true" />
              {eyebrow}
            </p>
          )}
          <h2
            id={`${id}-title`}
            className="text-foreground mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
          >
            {title}
          </h2>
          {intro ? (
            <p className="text-body mt-4 text-base leading-relaxed text-pretty sm:text-lg">{intro}</p>
          ) : null}
        </div>
        {children}
      </div>
    </section>
  );
}

/** A product screenshot in a light and a dark file; the stylesheet shows the one for the theme. */
function ThemedShot({
  light,
  dark,
  width,
  height,
  alt,
  priority = false,
  sizes,
  className,
}: {
  light: string;
  dark: string;
  width: number;
  height: number;
  alt: string;
  priority?: boolean;
  sizes: string;
  className?: string;
}): React.JSX.Element {
  return (
    <>
      <Image
        src={light}
        width={width}
        height={height}
        alt={alt}
        sizes={sizes}
        priority={priority}
        unoptimized
        className={cn("lp-shot-light h-auto w-full", className)}
      />
      <Image
        src={dark}
        width={width}
        height={height}
        alt={alt}
        sizes={sizes}
        loading="lazy"
        unoptimized
        className={cn("lp-shot-dark h-auto w-full", className)}
      />
    </>
  );
}

function Connector(): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="text-accent-foreground bg-card shadow-card border-border relative z-10 my-3 grid size-9 shrink-0 place-items-center rounded-full ring-1 ring-border lg:mx-3 lg:my-0"
    >
      <ArrowDownIcon className="size-4 lg:-rotate-90" />
    </span>
  );
}

function PathCard({
  path,
  icon: Icon,
}: {
  path: LandingStrings["paths"]["discovery"];
  icon: LucideIcon;
}): React.JSX.Element {
  return (
    <article className="bg-card shadow-card flex flex-col rounded-2xl p-6 sm:p-8">
      <div className="flex items-start gap-4">
        <span className="bg-accent text-accent-foreground grid size-11 shrink-0 place-items-center rounded-xl">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div>
          <p className="text-accent-foreground text-xs font-semibold tracking-wide uppercase">
            {path.kicker}
          </p>
          <h3 className="text-foreground mt-1 text-xl font-semibold tracking-tight text-balance">
            {path.title}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">{path.audience}</p>
        </div>
      </div>
      <ol className="mt-6 grid gap-5">
        {path.paragraphs.map((p, i) => (
          <li key={p} className="flex gap-3">
            <span
              aria-hidden="true"
              className="bg-muted text-muted-foreground mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold"
            >
              {i + 1}
            </span>
            <p className={bodyText}>{p}</p>
          </li>
        ))}
      </ol>
    </article>
  );
}

function Lane({
  title,
  steps,
  icons,
  visual,
}: {
  title: string;
  steps: LandingStrings["how"]["discovery"]["steps"];
  icons: readonly LucideIcon[];
  visual: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      {visual}
      <h3 className="text-foreground mt-8 text-xl font-semibold tracking-tight">{title}</h3>
      <ol className="mt-6">
        {steps.map((step, i) => {
          const Icon = icons[i] ?? CheckIcon;
          const last = i === steps.length - 1;
          return (
            <li key={step.title} className={cn("relative flex gap-4", !last && "pb-7")}>
              {!last ? (
                <span
                  aria-hidden="true"
                  className="bg-border absolute top-11 bottom-1 left-5 w-px -translate-x-1/2"
                />
              ) : null}
              <span className="bg-card text-accent-foreground shadow-card relative grid size-10 shrink-0 place-items-center rounded-full">
                <Icon className="size-[18px]" aria-hidden="true" />
              </span>
              <div className="min-w-0 pt-1">
                <h4 className="text-foreground text-base font-semibold">
                  <span className="text-muted-foreground mr-1.5 font-medium" aria-hidden="true">
                    {i + 1}.
                  </span>
                  {step.title}
                </h4>
                <p className={cn(bodyText, "mt-1")}>{step.body}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function FooterColumn({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <p className="text-foreground text-sm font-semibold">{title}</p>
      <ul className="text-muted-foreground mt-4 grid gap-2.5 text-sm [&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:hover]:underline">
        {children}
      </ul>
    </div>
  );
}
