"use client";

import type { Path } from "@aidp/shared";
import * as React from "react";
import { ConversationPane } from "./ConversationPane";
import { SpecPanel } from "./SpecPanel";
import { t } from "@/i18n";
import { staffClient } from "@/lib/api/browser";
import { requirementsSessionApi, toParticipantSession } from "@/lib/api/requirements-session";
import type { LiveSpec, RequirementsDetail } from "@/lib/api/schemas";
import { cn } from "@/lib/utils";

/**
 * The requirements workspace: the conversation on the left, the live spec on the right, each
 * scrolling on its own inside the viewport.
 * The spec refreshes from the `spec` SSE event after each turn and from the answers of
 * section edits and finding decisions. Reopening reloads the session and remounts the
 * conversation so the hook starts from the fresh transcript.
 */
export function RequirementsWorkspace({ initial }: { initial: RequirementsDetail }): React.JSX.Element {
  const id = initial.session.id;
  const api = React.useMemo(() => requirementsSessionApi(id), [id]);
  const [detail, setDetail] = React.useState(initial);
  const [spec, setSpec] = React.useState<LiveSpec>(initial.spec);
  const [generation, setGeneration] = React.useState(0);
  const [view, setView] = React.useState<"conversation" | "spec">("conversation");

  const setPath = React.useCallback(
    async (path: Path): Promise<void> => {
      await staffClient.requirements.setPath(id, path);
      setSpec((s) => ({ ...s, path }));
    },
    [id],
  );

  const reopen = React.useCallback(async (): Promise<void> => {
    await staffClient.requirements.reopen(id);
    const fresh = await staffClient.requirements.get(id);
    setDetail(fresh);
    setSpec(fresh.spec);
    setGeneration((g) => g + 1);
  }, [id]);

  const w = t.admin.requirements.workspace;
  return (
    // Fills the viewport (see AdminShell): the conversation and the spec each scroll on their own,
    // and the composer is always on screen. On a phone the two are views of one pane, not a stack
    // of two screen-tall boxes; both stay mounted so switching keeps the conversation's state.
    <div data-fill-viewport="" className="flex min-h-0 flex-1 flex-col gap-3">
      <div
        role="group"
        aria-label={w.viewLabel}
        className="bg-muted inline-flex shrink-0 self-start rounded-lg p-0.5 lg:hidden"
      >
        {(["conversation", "spec"] as const).map((v) => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            className={cn(
              "min-h-9 rounded-md px-3 text-sm font-medium transition-colors",
              view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
            )}
            onClick={() => {
              setView(v);
            }}
          >
            {v === "conversation" ? w.conversation : w.specification}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 gap-6 lg:grid-cols-2">
        <div className={cn("flex min-h-0 flex-col", view === "conversation" ? "" : "max-lg:hidden")}>
          <ConversationPane
            key={generation}
            api={api}
            initial={toParticipantSession(detail)}
            title={detail.session.title || spec.title}
            onSpec={setSpec}
            onSetPath={setPath}
            onReopen={reopen}
          />
        </div>
        <div
          className={cn(
            "min-h-0 overflow-y-auto overscroll-contain lg:pr-1",
            view === "spec" ? "" : "max-lg:hidden",
          )}
        >
          <SpecPanel
            sessionId={id}
            spec={spec}
            onSpec={setSpec}
            versions={detail.versions}
            invitations={detail.invitations}
          />
        </div>
      </div>
    </div>
  );
}
