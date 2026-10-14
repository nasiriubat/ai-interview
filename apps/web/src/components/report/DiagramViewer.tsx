"use client";

import { CodeIcon, ImageIcon, MaximizeIcon, MinusIcon, PlusIcon, ScalingIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const STEP = 1.25;

/** The next zoom level, clamped; pure so it can be tested without a browser. */
export function nextZoom(current: number, direction: "in" | "out" | "reset"): number {
  if (direction === "reset") return 1;
  const next = direction === "in" ? current * STEP : current / STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
}

/**
 * A drawn diagram that can be read at any size (FR-23): zoom in and out, drag to pan, open it full
 * screen, and swap it for its Mermaid source. The drawing is the server's own SVG, already
 * sanitized by Mermaid's strict mode; zoom is a width on its wrapper, so text stays vector-sharp.
 */
export function DiagramViewer({
  html,
  natural,
  code,
  label,
}: {
  html: string;
  natural: number;
  code: string;
  label: string;
}): React.JSX.Element {
  const [full, setFull] = React.useState(false);
  return (
    <>
      <Surface
        html={html}
        natural={natural}
        code={code}
        label={label}
        onFullscreen={() => {
          setFull(true);
        }}
      />
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent
          closeLabel={t.admin.report.diagramClose}
          className="h-[calc(100dvh-1.5rem)] max-h-none w-[calc(100vw-1.5rem)] max-w-none grid-rows-[auto_minmax(0,1fr)] p-3 sm:max-w-none sm:p-4"
          aria-describedby={undefined}
        >
          <DialogTitle className="truncate pr-8 text-base">{label}</DialogTitle>
          <DialogDescription className="sr-only">{t.admin.report.diagramHint}</DialogDescription>
          <Surface html={html} natural={natural} code={code} label={label} fill />
        </DialogContent>
      </Dialog>
    </>
  );
}

function Surface({
  html,
  natural,
  code,
  label,
  onFullscreen,
  fill = false,
}: {
  html: string;
  natural: number;
  code: string;
  label: string;
  onFullscreen?: (() => void) | undefined;
  fill?: boolean;
}): React.JSX.Element {
  const r = t.admin.report;
  const [zoom, setZoom] = React.useState(1);
  const [source, setSource] = React.useState(false);
  const viewport = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "+" || e.key === "=") setZoom((z) => nextZoom(z, "in"));
    else if (e.key === "-" || e.key === "_") setZoom((z) => nextZoom(z, "out"));
    else if (e.key === "0") setZoom(1);
  };

  return (
    <div className={fill ? "flex min-h-0 flex-col gap-2" : "grid gap-2"}>
      <div
        role="toolbar"
        aria-label={r.diagramTools}
        className="flex flex-wrap items-center justify-end gap-1 print:hidden"
      >
        {!source ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={r.diagramZoomOut}
              disabled={zoom <= MIN_ZOOM}
              onClick={() => {
                setZoom((z) => nextZoom(z, "out"));
              }}
            >
              <MinusIcon aria-hidden="true" />
            </Button>
            <span aria-live="polite" className="text-muted-foreground w-12 text-center text-xs tabular-nums">
              {r.diagramZoom(Math.round(zoom * 100))}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={r.diagramZoomIn}
              disabled={zoom >= MAX_ZOOM}
              onClick={() => {
                setZoom((z) => nextZoom(z, "in"));
              }}
            >
              <PlusIcon aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={r.diagramZoomReset}
              disabled={zoom === 1}
              onClick={() => {
                setZoom(1);
              }}
            >
              <ScalingIcon aria-hidden="true" />
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={source}
          onClick={() => {
            setSource((s) => !s);
          }}
        >
          {source ? <ImageIcon aria-hidden="true" /> : <CodeIcon aria-hidden="true" />}
          {source ? r.diagramShowDrawing : r.diagramShowSource}
        </Button>
        {onFullscreen ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={r.diagramFullscreen}
            onClick={onFullscreen}
          >
            <MaximizeIcon aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      {source ? (
        <pre
          tabIndex={0}
          aria-label={label}
          className="bg-muted/50 max-h-[32rem] min-w-0 overflow-auto rounded-lg p-3 text-xs"
        >
          <code>{code}</code>
        </pre>
      ) : (
        <div
          ref={viewport}
          tabIndex={0}
          role="group"
          aria-label={`${label}. ${r.diagramHint}`}
          onKeyDown={onKeyDown}
          onPointerDown={(e) => {
            const el = viewport.current;
            if (!el || e.button !== 0) return;
            drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
            setDragging(true);
            el.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const el = viewport.current;
            const d = drag.current;
            if (!el || !d) return;
            el.scrollLeft = d.left - (e.clientX - d.x);
            el.scrollTop = d.top - (e.clientY - d.y);
          }}
          onPointerUp={() => {
            drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          className={`bg-card min-w-0 overflow-auto rounded-lg [touch-action:pan-x_pan-y] ${
            fill ? "min-h-0 flex-1" : "max-h-[75dvh]"
          } ${dragging ? "cursor-grabbing select-none" : "cursor-grab"}`}
        >
          <div
            role="img"
            aria-label={label}
            className="report-diagram"
            style={{
              width: `${String(Math.round(zoom * 100))}%`,
              minWidth: "100%",
              ...(natural > 0 ? { "--diagram-natural": `${String(natural)}px` } : {}),
            }}
            // Mermaid's own DOMPurify pass runs in `strict` mode; the source is our API's report.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      )}
    </div>
  );
}
