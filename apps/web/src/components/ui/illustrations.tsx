import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The empty-state and global-state illustration set (D-392). Inline SVG: no request, no image
 * pipeline, and it follows the theme because every colour is a token. All are decorative
 * (`aria-hidden`); the title and body beside them carry the meaning. One viewBox (160 x 120), one
 * stroke weight, one accent, so a page never shows two styles.
 */
export type IllustrationName =
  | "mail"
  | "notFound"
  | "error"
  | "lock"
  | "offline"
  | "maintenance"
  | "suspended"
  | "campaign"
  | "template"
  | "users"
  | "results"
  | "search"
  | "inbox"
  | "expired";

const SOFT = "var(--accent)";
const LINE = "var(--input)";
const CARD = "var(--card)";
const ACCENT = "var(--primary)";
const MUTED = "var(--muted)";

function Sheet(): React.JSX.Element {
  return <rect x="40" y="24" width="80" height="72" rx="8" fill={CARD} stroke={LINE} strokeWidth="1.5" />;
}

function Lines({ x, y, widths }: { x: number; y: number; widths: number[] }): React.JSX.Element {
  return (
    <>
      {widths.map((w, i) => (
        <rect key={i} x={x} y={y + i * 10} width={w} height="5" rx="2.5" fill={MUTED} />
      ))}
    </>
  );
}

function Badge({
  cx,
  cy,
  children,
}: {
  cx: number;
  cy: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <g>
      <circle cx={cx} cy={cy} r="16" fill={ACCENT} />
      <g
        transform={`translate(${String(cx)} ${String(cy)})`}
        stroke="var(--primary-foreground)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      >
        {children}
      </g>
    </g>
  );
}

function Art({ name }: { name: IllustrationName }): React.JSX.Element {
  switch (name) {
    case "mail":
      return (
        <>
          <rect x="34" y="34" width="92" height="62" rx="8" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <path d="M38 40l42 31 42-31" fill="none" stroke={LINE} strokeWidth="1.5" strokeLinejoin="round" />
          <Badge cx={122} cy={38}>
            <path d="M-6 0l4 4 8-8" />
          </Badge>
        </>
      );
    case "notFound":
      return (
        <>
          <Sheet />
          <Lines x={52} y={40} widths={[56, 40, 48]} />
          <circle cx="98" cy="82" r="16" fill={CARD} stroke={ACCENT} strokeWidth="4" />
          <path d="M110 94l12 12" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" />
          <path d="M93 78l10 8M103 78l-10 8" stroke={ACCENT} strokeWidth="2.5" strokeLinecap="round" />
        </>
      );
    case "error":
      return (
        <>
          <Sheet />
          <Lines x={52} y={64} widths={[56, 36]} />
          <Badge cx={80} cy={44}>
            <path d="M0 -7v8M0 6v.5" />
          </Badge>
        </>
      );
    case "lock":
    case "suspended":
      return (
        <>
          <rect x="46" y="54" width="68" height="46" rx="8" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <path
            d="M60 54V42a20 20 0 0140 0v12"
            fill="none"
            stroke={ACCENT}
            strokeWidth="5"
            strokeLinecap="round"
          />
          <circle cx="80" cy="74" r="6" fill={ACCENT} />
          <path d="M80 78v10" stroke={ACCENT} strokeWidth="4" strokeLinecap="round" />
          {name === "suspended" ? (
            <rect
              x="40"
              y="48"
              width="80"
              height="58"
              rx="12"
              fill="none"
              stroke={ACCENT}
              strokeWidth="1.5"
              strokeDasharray="4 4"
            />
          ) : null}
        </>
      );
    case "offline":
      return (
        <>
          <path d="M48 74a32 32 0 0164 0" fill="none" stroke={LINE} strokeWidth="5" strokeLinecap="round" />
          <path d="M60 84a18 18 0 0140 0" fill="none" stroke={LINE} strokeWidth="5" strokeLinecap="round" />
          <circle cx="80" cy="96" r="5" fill={LINE} />
          <path d="M44 36l72 64" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" />
        </>
      );
    case "maintenance":
      return (
        <>
          <rect x="36" y="34" width="88" height="58" rx="8" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <path d="M36 42a8 8 0 018-8h72a8 8 0 018 8v6H36z" fill={MUTED} />
          <circle cx="46" cy="41" r="2.5" fill={LINE} />
          <circle cx="55" cy="41" r="2.5" fill={LINE} />
          <circle cx="80" cy="72" r="13" fill="none" stroke={ACCENT} strokeWidth="5" strokeDasharray="6 5" />
          <circle cx="80" cy="72" r="4" fill={ACCENT} />
        </>
      );
    case "expired":
      return (
        <>
          <circle cx="80" cy="64" r="34" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <path
            d="M80 42v22l15 9"
            fill="none"
            stroke={ACCENT}
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="80" cy="64" r="3" fill={ACCENT} />
        </>
      );
    case "campaign":
      return (
        <>
          <Sheet />
          <rect x="52" y="38" width="30" height="8" rx="4" fill={ACCENT} />
          <Lines x={52} y={56} widths={[56, 44]} />
          <path d="M98 100l22-22" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" />
          <circle cx="120" cy="78" r="8" fill={ACCENT} />
        </>
      );
    case "template":
      return (
        <>
          <rect x="40" y="28" width="52" height="64" rx="8" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <rect x="68" y="40" width="52" height="64" rx="8" fill={CARD} stroke={ACCENT} strokeWidth="2" />
          <Lines x={78} y={54} widths={[32, 24, 30]} />
          <rect x="78" y="86" width="20" height="8" rx="4" fill={ACCENT} />
        </>
      );
    case "users":
      return (
        <>
          <circle cx="58" cy="52" r="12" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <path d="M36 98a22 22 0 0144 0z" fill={CARD} stroke={LINE} strokeWidth="1.5" />
          <circle cx="100" cy="46" r="14" fill={CARD} stroke={ACCENT} strokeWidth="2" />
          <path
            d="M74 100a26 26 0 0152 0z"
            fill={CARD}
            stroke={ACCENT}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </>
      );
    case "results":
      return (
        <>
          <Sheet />
          <rect x="54" y="68" width="12" height="20" rx="3" fill={MUTED} />
          <rect x="74" y="54" width="12" height="34" rx="3" fill={ACCENT} />
          <rect x="94" y="62" width="12" height="26" rx="3" fill={MUTED} />
          <path d="M54 42h28" stroke={LINE} strokeWidth="5" strokeLinecap="round" />
        </>
      );
    case "search":
      return (
        <>
          <Sheet />
          <Lines x={52} y={40} widths={[56, 40]} />
          <circle cx="94" cy="76" r="14" fill={CARD} stroke={ACCENT} strokeWidth="4" />
          <path d="M104 86l12 12" stroke={ACCENT} strokeWidth="5" strokeLinecap="round" />
        </>
      );
    default:
      return (
        <>
          <path
            d="M36 70l14-30h60l14 30v22a6 6 0 01-6 6H42a6 6 0 01-6-6z"
            fill={CARD}
            stroke={LINE}
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path
            d="M36 70h30l4 10h20l4-10h30"
            fill="none"
            stroke={ACCENT}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
        </>
      );
  }
}

export function Illustration({
  name,
  className,
}: {
  name: IllustrationName;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 160 120"
      aria-hidden="true"
      focusable="false"
      className={cn("h-auto w-40 shrink-0", className)}
    >
      <ellipse cx="80" cy="64" rx="64" ry="46" fill={SOFT} />
      <Art name={name} />
    </svg>
  );
}
