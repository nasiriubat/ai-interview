import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { currentLocale } from "@/i18n";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number | undefined | null): string {
  if (cents === undefined || cents === null) return "–";
  return new Intl.NumberFormat(currentLocale(), { style: "currency", currency: "EUR" }).format(cents / 100);
}

export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null) return "–";
  return new Intl.NumberFormat(currentLocale()).format(n);
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(currentLocale(), { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** Turns `camelCase` or `snake_case` keys into a readable label. */
export function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** 0.1234 → "12.3 %" in the reader's locale. */
export function formatPercent(ratio: number | undefined | null, digits = 1): string {
  if (ratio === undefined || ratio === null || !Number.isFinite(ratio)) return "–";
  return new Intl.NumberFormat(currentLocale(), {
    style: "percent",
    maximumFractionDigits: digits,
  }).format(ratio);
}

/** 3,644,946 → "3.6M": for tiles, where the exact figure is in the tooltip or table. */
export function formatCompact(n: number | undefined | null): string {
  if (n === undefined || n === null) return "–";
  return new Intl.NumberFormat(currentLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Milliseconds as the unit a person would say: "850 ms", "17.5 s", "2 min". */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return "–";
  const nf = (v: number, d: number): string =>
    new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: d }).format(v);
  if (ms < 1000) return `${nf(ms, 0)} ms`;
  if (ms < 60_000) return `${nf(ms / 1000, 1)} s`;
  return `${nf(ms / 60_000, 1)} min`;
}
