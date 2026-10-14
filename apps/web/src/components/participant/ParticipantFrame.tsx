"use client";

import { InfoIcon, PanelRightIcon, PauseIcon } from "lucide-react";
import * as React from "react";
import { IconButton } from "@/components/admin/IconButton";
import { LanguageMenu, ThemeMenu } from "@/components/common/PreferenceMenus";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

/*
 * The one frame every participant screen sits in (D-420): arrival, consent, the interview, paused,
 * deleted and the end all share the same slim header and the same calm page, so the flow reads as
 * one product and nothing jumps between steps.
 *
 *   - `ParticipantPage` is the frame for a single card (arrival, consent, status screens).
 *   - `InterviewFrame` is the app frame: a full-height conversation card with the composer docked
 *     at its bottom and, on wide screens, a quiet side panel beside it.
 */

const PANEL_KEY = "aidp.participantPanel";

/** The page behind the card: a flat tone with a faint brand wash at the top, never an empty band. */
const PAGE_BG =
  "bg-background bg-[linear-gradient(180deg,color-mix(in_oklab,var(--primary)_9%,transparent),transparent_22rem)]";

/**
 * The one place the brand renders in the participant frame: the product name as plain text, under
 * the interview's own name. A platform logo can replace or join the text here and nowhere else.
 */
export function ParticipantBrand({
  title,
  productName,
}: {
  title: string;
  productName?: string | undefined;
}): React.JSX.Element {
  const product = productName !== undefined && productName !== "" ? productName : t.app.name;
  return (
    <div className="min-w-0 leading-tight">
      <p className="text-foreground truncate text-[15px] font-semibold tracking-tight">{title}</p>
      {product !== title ? <p className="text-muted-foreground truncate text-xs">{product}</p> : null}
    </div>
  );
}

/** Language and appearance as two compact menus, the same ones the rest of the app uses. */
export function PreferenceMenus({ className }: { className?: string }): React.JSX.Element {
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <LanguageMenu className="h-9" />
      <ThemeMenu className="size-9" />
    </div>
  );
}

function Header({
  title,
  subtitle,
  centre,
  actions,
}: {
  title: string;
  subtitle?: string | undefined;
  centre?: React.ReactNode;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <header className="bg-card/85 supports-[backdrop-filter]:bg-card/70 relative z-20 shrink-0 border-b backdrop-blur">
      <div className="mx-auto grid h-14 w-full max-w-[1320px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,1fr)]">
        <ParticipantBrand title={title} productName={subtitle} />
        <div className="hidden min-w-0 justify-center lg:flex">{centre}</div>
        <div className="flex shrink-0 items-center justify-end gap-1">{actions}</div>
      </div>
    </header>
  );
}

/** A single card on the shared page: arrival, consent, paused, deleted, closed, expired. */
export function ParticipantPage({
  title,
  subtitle,
  children,
  width = "narrow",
  card = true,
  className,
}: {
  title?: string | undefined;
  subtitle?: string | undefined;
  children: React.ReactNode;
  /** `wide` gives a two-column card on large screens (the arrival). */
  width?: "narrow" | "wide";
  card?: boolean;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div className={cn("flex min-h-dvh flex-col", PAGE_BG)}>
      <Header title={title ?? t.app.name} subtitle={subtitle} actions={<PreferenceMenus />} />
      <main
        id="main"
        className="flex flex-1 items-start justify-center px-3 py-6 sm:px-6 sm:py-10 lg:items-center lg:py-14"
      >
        <div
          className={cn(
            "w-full",
            width === "wide" ? "max-w-[56rem]" : "max-w-[34rem]",
            card && "bg-card shadow-raised rounded-2xl p-6 sm:p-9",
            className,
          )}
        >
          {children}
        </div>
      </main>
      <p className="text-muted-foreground px-4 pb-6 text-center text-xs">
        {t.participant.session.pageFooter}
      </p>
    </div>
  );
}

/** "3 of 5 topics" with a thin bar: the calm progress indicator in the middle of the header. */
export function HeaderProgress({ done, total }: { done: number; total: number }): React.JSX.Element | null {
  if (total === 0) return null;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-3" data-header-progress="">
      <div aria-hidden="true" className="bg-muted h-1.5 w-32 overflow-hidden rounded-full lg:w-44">
        <div
          className="bg-primary h-full rounded-full transition-[width] duration-500"
          style={{ width: `${String(pct)}%` }}
        />
      </div>
      <span className="text-muted-foreground text-xs font-medium tabular-nums whitespace-nowrap">
        {t.participant.session.topicsShort(done, total)}
      </span>
    </div>
  );
}

function readPanelPref(): boolean {
  try {
    return window.localStorage.getItem(PANEL_KEY) !== "closed";
  } catch {
    return true;
  }
}

/**
 * The interview's app frame. Below 1280 px the side panel is a sheet opened from the header; from
 * 1280 px it sits beside the card and can be collapsed (the choice is remembered in this browser).
 */
export function InterviewFrame({
  title,
  subtitle,
  progress,
  onPause,
  pauseDisabled,
  menu,
  panel,
  banner,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  progress: { done: number; total: number };
  onPause: () => void;
  pauseDisabled?: boolean;
  /** The overflow menu (finish, download, delete). */
  menu: React.ReactNode;
  /** The side panel's content; mounted in the aside and, below 1280 px, in the sheet when open. */
  panel: React.ReactNode;
  /** A line under the header (offline). */
  banner?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const s = t.participant.session;
  const wide = useMediaQuery("(min-width: 1280px)");
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  React.useEffect(() => {
    setPanelOpen(readPanelPref());
  }, []);
  const togglePanel = (): void => {
    if (!wide) {
      setSheetOpen(true);
      return;
    }
    const next = !panelOpen;
    setPanelOpen(next);
    try {
      window.localStorage.setItem(PANEL_KEY, next ? "open" : "closed");
    } catch {
      // A per-viewer convenience: not being able to remember it is fine.
    }
  };

  return (
    <div className={cn("flex h-dvh flex-col overflow-hidden", PAGE_BG)}>
      <Header
        title={title}
        subtitle={subtitle}
        centre={<HeaderProgress done={progress.done} total={progress.total} />}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="hidden h-9 md:inline-flex"
              disabled={pauseDisabled}
              onClick={onPause}
              title={s.pauseSaveHint}
            >
              <PauseIcon aria-hidden="true" />
              {s.pauseSave}
            </Button>
            <IconButton
              className="md:hidden"
              size="icon"
              label={s.pauseSave}
              icon={<PauseIcon />}
              disabled={pauseDisabled}
              onClick={onPause}
            />
            <IconButton
              size="icon"
              label={s.panelToggle}
              icon={
                <>
                  <InfoIcon className="xl:hidden" />
                  <PanelRightIcon className="hidden xl:block" />
                </>
              }
              onClick={togglePanel}
            />
            <PreferenceMenus className="hidden sm:flex" />
            {menu}
          </>
        }
      />
      {progress.total > 0 ? (
        // Below the width where the header has room for it, progress is a thin line under the header.
        <div aria-hidden="true" className="bg-muted h-0.5 shrink-0 lg:hidden">
          <div
            className="bg-primary h-full transition-[width] duration-500"
            style={{ width: `${String(Math.round((progress.done / progress.total) * 100))}%` }}
          />
        </div>
      ) : null}
      {banner}
      <div className="flex min-h-0 flex-1 justify-center sm:p-4 2xl:p-6">
        <div className="flex min-h-0 w-full max-w-[1320px] gap-4">
          <main
            id="main"
            className="bg-card flex min-h-0 min-w-0 flex-1 flex-col sm:rounded-2xl sm:border sm:shadow-card"
          >
            {children}
          </main>
          {panelOpen ? (
            <aside
              aria-label={s.panelToggle}
              className="hidden min-h-0 w-[21rem] shrink-0 flex-col overflow-y-auto xl:flex"
            >
              {panel}
            </aside>
          ) : null}
        </div>
      </div>
      <Sheet open={sheetOpen && !wide} onOpenChange={setSheetOpen}>
        <SheetContent closeLabel={t.app.close} className="bg-background gap-5 sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{s.panelToggle}</SheetTitle>
            <SheetDescription className="sr-only">{s.sessionMenuHint}</SheetDescription>
          </SheetHeader>
          {panel}
        </SheetContent>
      </Sheet>
    </div>
  );
}
