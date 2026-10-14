"use client";

import { AlertTriangleIcon, CheckCircle2Icon, CircleAlertIcon, DownloadIcon } from "lucide-react";
import * as React from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { isApiError } from "@/lib/api/errors";
import { saveFromUrl, saveText, type SavedFile } from "@/lib/exports/download";

/**
 * One thing the panel can hand over. A file is either fetched (`url`, through the staff proxy,
 * where the server composes it) or already in the page (`text`).
 */
export type ExportItem = {
  id: string;
  /** The button's label. */
  label: string;
  /** What "Preparing …" and an error call it, in the sentence: "PDF", "Markdown". */
  what: string;
  fallbackName: string;
} & ({ url: string } | { text: { content: string; filename: string; mime: string } });

type State =
  | { phase: "idle" }
  | { phase: "preparing"; item: ExportItem }
  | { phase: "done"; item: ExportItem; file: SavedFile }
  | { phase: "error"; item: ExportItem; message: string };

/** What a warning code from the server means to the person downloading. */
export function warningText(code: string): string {
  const w = t.admin.exportsPanel.warnings;
  const [kind, n] = code.split(":");
  const index = Number(n);
  switch (kind) {
    case "diagram_unrendered":
      return w.diagramUnrendered(Number.isFinite(index) ? index : 0);
    case "diagram_syntax":
      return w.diagramSyntax(Number.isFinite(index) ? index : 0);
    case "diagram_over_limit":
      return w.diagramOverLimit;
    case "diagram_too_large":
      return w.diagramTooLarge;
    case "truncated":
      return w.truncated;
    case "table_columns_truncated":
    case "table_rows_truncated":
      return w.table;
    default:
      return w.other(code);
  }
}

function reasonOf(e: unknown): string {
  const p = t.admin.exportsPanel;
  if (isApiError(e)) {
    if (e.code === "rate_limited") return p.busy;
    if (e.code === "too_large") return p.tooLarge;
    return e.message || t.app.unknownError;
  }
  return t.app.unknownError;
}

/**
 * The export panel of a report or a specification version: every format in one place, with the
 * three states a download that is composed on the server has (preparing, done, failed), announced
 * to assistive technology, and what the server left out of the file said in words (D-211).
 * Extra actions that are not downloads, such as the push to GitHub, go in as children.
 */
export function ExportsPanel({
  items,
  children,
  heading = t.admin.exportsPanel.title,
}: {
  items: readonly ExportItem[];
  children?: React.ReactNode;
  heading?: string;
}): React.JSX.Element {
  const [state, setState] = React.useState<State>({ phase: "idle" });
  const headingId = React.useId();
  const busy = state.phase === "preparing";

  const run = async (item: ExportItem): Promise<void> => {
    setState({ phase: "preparing", item });
    try {
      const file =
        "url" in item
          ? await saveFromUrl(item.url, item.fallbackName)
          : saveText(item.text.content, item.text.filename, item.text.mime);
      setState({ phase: "done", item, file });
    } catch (e) {
      setState({ phase: "error", item, message: reasonOf(e) });
    }
  };

  const p = t.admin.exportsPanel;
  return (
    <section aria-labelledby={headingId} className="grid gap-3 print:hidden">
      <h2 id={headingId} className="text-base font-semibold">
        {heading}
      </h2>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <Button
            key={item.id}
            variant="outline"
            disabled={busy}
            loading={state.phase === "preparing" && state.item.id === item.id}
            onClick={() => {
              void run(item);
            }}
          >
            <DownloadIcon /> {item.label}
          </Button>
        ))}
        {children}
      </div>

      {/* Always in the DOM, so the announcement of a result is a change, not an appearance. */}
      <p role="status" aria-live="polite" className="text-muted-foreground flex items-center gap-2 text-sm">
        {state.phase === "preparing" ? p.preparing(state.item.what) : null}
        {state.phase === "done" ? (
          <>
            <CheckCircle2Icon className="text-success size-4" aria-hidden="true" />
            <span>
              {p.done(state.file.filename)}
              {state.file.pages ? ` ${p.pagesNote(state.file.pages)}` : ""}
            </span>
          </>
        ) : null}
      </p>

      {state.phase === "error" ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription>
            <p>{p.failed(state.item.what, state.message)}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                void run(state.item);
              }}
            >
              {p.retry}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {state.phase === "done" && state.file.warnings.length > 0 ? (
        <Alert variant="warning" role="status">
          <AlertTriangleIcon aria-hidden="true" />
          <AlertDescription>
            <p className="font-medium">{p.warningsTitle}</p>
            <ul className="list-disc pl-5">
              {state.file.warnings.map((code) => (
                <li key={code}>{warningText(code)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
