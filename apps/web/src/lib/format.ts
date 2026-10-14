import { currentLocale } from "@/i18n";
import { formatNumber } from "@/lib/utils";

/** "September 2026" from `2026-09`, in the reader's language. */
export function formatMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  if (!y || !m) return month;
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/** A byte count the way a person reads storage: MB under a gigabyte, GB above. */
export function formatBytes(n: number): string {
  const mb = 1024 * 1024;
  const gb = 1024 * mb;
  return n >= gb
    ? `${new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 1 }).format(n / gb)} GB`
    : `${formatNumber(Math.round(n / mb))} MB`;
}

/** The previous calendar month as `yyyy-mm`, UTC: the newest month a statement exists for. */
export function previousMonth(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}
