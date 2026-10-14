import { t } from "@/i18n";
import type { FilterDef } from "@/lib/admin/table-state";
import type { ListDef } from "@/lib/api/lists";

/**
 * Filter definitions for the data table, built from `lib/api/lists.ts` so a menu can only offer
 * values the API accepts (D-341). The result is plain data, so a server page may pass it on.
 */
export function enumFilterDef(
  list: ListDef,
  key: string,
  label: string,
  labelOf: (value: string) => string,
): FilterDef {
  const kind = list.filters[key];
  const values = Array.isArray(kind) ? (kind as readonly string[]) : [];
  return {
    type: "select",
    key,
    label,
    options: values.map((value) => ({ value, label: labelOf(value) })),
  };
}

/** The status filter most lists have. */
export function statusFilterDef(list: ListDef): FilterDef {
  return enumFilterDef(
    list,
    "status",
    t.admin.list.fields.status ?? "Status",
    (v) => t.admin.list.statuses[v] ?? v,
  );
}

/** A date range over two `date` filters of a list (`from` and `to`). */
export function dateRangeFilterDef(label: string, fromKey = "from", toKey = "to"): FilterDef {
  return { type: "date-range", label, fromKey, toKey };
}
