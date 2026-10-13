import type { ToolbarFilter } from "@/components/admin/ListToolbar";
import { t } from "@/i18n";
import type { ListDef } from "@/lib/api/lists";

/**
 * A toolbar filter for one of a list's enum filters, its choices taken from `lib/api/lists.ts` so
 * the menu can only ever offer values the API accepts.
 */
export function enumFilter(
  list: ListDef,
  key: string,
  label: string,
  allLabel: string,
  labelOf: (value: string) => string,
): ToolbarFilter {
  const kind = list.filters[key];
  const values = Array.isArray(kind) ? (kind as readonly string[]) : [];
  return { key, label, allLabel, options: values.map((value) => ({ value, label: labelOf(value) })) };
}

/** The status filter most lists have. */
export function statusFilter(list: ListDef): ToolbarFilter {
  return enumFilter(
    list,
    "status",
    t.admin.list.fields.status ?? "Status",
    t.admin.list.allStatuses,
    (v) => t.admin.list.statuses[v] ?? v,
  );
}

/** True when the URL narrows the list, so an empty page means "no matches", not "nothing yet". */
export function isFiltered(q: string | undefined, filters: Record<string, unknown>): boolean {
  return q !== undefined || Object.values(filters).some((v) => v !== undefined && v !== "");
}
