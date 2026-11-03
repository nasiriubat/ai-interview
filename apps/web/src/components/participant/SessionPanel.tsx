"use client";

import { CoffeeIcon, ShieldCheckIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { ProgressAreas } from "./ProgressAreas";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { ProgressArea } from "@/lib/api/schemas";

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="bg-card shadow-card rounded-2xl p-4">
      <h2 className="text-foreground mb-2 flex items-center gap-2 text-sm font-semibold">
        {icon ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {icon}
          </span>
        ) : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Quiet context beside the conversation (D-422): what this interview is about, the topics as a
 * checklist (each can be skipped or come back to), how answers are used, how to take a break, and
 * the way out. It is the same content in the wide-screen side panel and in the narrow-screen sheet.
 */
export function SessionPanel({
  welcome,
  backgroundShared = false,
  areas,
  disabled,
  onSkip,
  onReturn,
  onRequestDelete,
}: {
  /** The participant-facing welcome (D-460), never the template objective. */
  welcome?: string | undefined;
  /** The organisation gave the interviewer background material (D-491); said beside how answers are used. */
  backgroundShared?: boolean | undefined;
  areas: ProgressArea[];
  disabled: boolean;
  onSkip: (area: ProgressArea) => void;
  onReturn: (area: ProgressArea) => void;
  onRequestDelete: () => void;
}): React.JSX.Element {
  const s = t.participant.session;
  const done = areas.filter((a) => a.status === "covered").length;
  return (
    <div className="grid gap-3 content-start">
      <Section title={s.panelAbout}>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {welcome !== undefined && welcome !== "" ? welcome : s.panelAboutFallback}
        </p>
      </Section>
      {areas.length > 0 ? (
        <Section title={s.panelTopics}>
          <p className="text-muted-foreground mb-2 text-xs">{s.panelTopicsDone(done, areas.length)}</p>
          <ProgressAreas areas={areas} disabled={disabled} onSkip={onSkip} onReturn={onReturn} />
        </Section>
      ) : null}
      <Section title={s.panelData} icon={<ShieldCheckIcon className="size-4" />}>
        <p className="text-muted-foreground text-sm leading-relaxed">{s.panelDataBody}</p>
        {backgroundShared ? (
          <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{s.panelBackground}</p>
        ) : null}
      </Section>
      <Section title={s.panelBreak} icon={<CoffeeIcon className="size-4" />}>
        <p className="text-muted-foreground text-sm leading-relaxed">{s.panelBreakBody}</p>
      </Section>
      <Section title={s.panelPrivacy} icon={<Trash2Icon className="size-4" />}>
        <p className="text-muted-foreground text-sm leading-relaxed">{s.panelPrivacyBody}</p>
        <Button
          type="button"
          variant="ghost"
          className="text-destructive hover:text-destructive -ml-3 mt-1 h-10"
          onClick={onRequestDelete}
        >
          {s.panelDelete}
        </Button>
      </Section>
    </div>
  );
}
