/**
 * What each staff list accepts beyond `limit` and `offset` (D-79, contract 19). Mirrors the
 * `listSpec` declarations in apps/api/src/modules/*\/routes.ts and the table in
 * docs/spec/19-admin-configuration.md; the API is the authority and answers 400 to anything
 * not listed here.
 *
 * - `sort`: every sortable field and the direction it takes when no `dir` is sent. The first
 *   key is the default sort.
 * - `filters`: a list of allowed values (an enum), `"date"` (`YYYY-MM-DD`), or a pattern the
 *   value must match, identical to the API's.
 * - `search`: whether `q` means anything on this list.
 */
import type { PageInput, SortDir } from "@aidp/shared";

export type { SortDir };
export type FilterKind = readonly string[] | "date" | { pattern: RegExp; max: number };

/** An audit action (`campaign.create`) or, ending in a dot, a family of them (`campaign.`). */
export const AUDIT_ACTION = { pattern: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*\.?$/, max: 100 } as const;
const IDENTIFIER = { pattern: /^[a-z][a-z0-9_]*$/, max: 50 } as const;
const REGION = { pattern: /^[a-z0-9-]+$/, max: 20 } as const;

/**
 * What a client component may be given of a list definition: the sorts, and nothing else. A
 * definition's filters can hold a RegExp, which React Server Components cannot serialize, so
 * handing the whole definition to the toolbar broke the audit and tenants pages in a production
 * build (found by the Security M3 Playwright pass, whose server log named it).
 */
export function sortOf(list: ListDef): Pick<ListDef, "sort" | "defaultSort"> {
  return { sort: list.sort, defaultSort: list.defaultSort };
}

export interface ListDef {
  sort: Readonly<Record<string, SortDir>>;
  defaultSort: string;
  search: boolean;
  filters: Readonly<Record<string, FilterKind>>;
}

export const LISTS = {
  campaigns: {
    sort: { createdAt: "desc", name: "asc", status: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: { status: ["draft", "open", "analyzing", "closed"] },
  },
  campaignSessions: {
    sort: { createdAt: "desc", startedAt: "desc", lastActivity: "desc", status: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: {
      status: ["created", "consented", "active", "paused", "completed", "deleted"],
      /** `true` lists the interviews the engine flagged for hostility or distress (D-173). */
      flagged: ["true", "false"],
    },
  },
  invitations: {
    sort: { createdAt: "asc", email: "asc", status: "asc", sentAt: "desc", openedAt: "desc" },
    defaultSort: "createdAt",
    search: true,
    filters: { status: ["pending", "sent", "opened", "bound", "revoked", "expired"] },
  },
  analyses: {
    sort: { version: "desc", createdAt: "desc" },
    defaultSort: "version",
    search: false,
    filters: { status: ["queued", "running", "done", "failed"] },
  },
  requirements: {
    sort: { createdAt: "desc", title: "asc", status: "asc", lastActivity: "desc" },
    defaultSort: "createdAt",
    search: true,
    filters: { status: ["created", "consented", "active", "paused", "completed"] },
  },
  templates: {
    sort: { key: "asc", name: "asc", updatedAt: "desc" },
    defaultSort: "key",
    search: true,
    filters: { status: ["draft", "published", "archived"], origin: ["tenant", "platform"] },
  },
  users: {
    sort: { createdAt: "asc", email: "asc", name: "asc", role: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: { role: ["admin", "member", "platform_operator"] },
  },
  audit: {
    sort: { createdAt: "desc", action: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: { action: AUDIT_ACTION, targetType: IDENTIFIER, from: "date", to: "date" },
  },
  budgets: {
    sort: { createdAt: "asc", limitCents: "desc", scope: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: { scope: ["tenant", "campaign", "session"], period: ["month", "total"] },
  },
  prices: {
    sort: { model: "asc", inputPerMtok: "asc", outputPerMtok: "asc", updatedAt: "desc" },
    defaultSort: "model",
    search: true,
    filters: { source: ["seed", "provider", "admin"] },
  },
  tenants: {
    sort: { createdAt: "asc", name: "asc", status: "asc" },
    defaultSort: "createdAt",
    search: true,
    filters: { status: ["active", "suspended"], region: REGION },
  },
} as const satisfies Record<string, ListDef>;

export type ListName = keyof typeof LISTS;

/** The sort keys a list accepts. */
export type SortOf<L extends ListDef> = Extract<keyof L["sort"], string>;

/** The filter values a list accepts: the enum's members, or a string for dates and tokens. */
export type FiltersOf<L extends ListDef> = {
  [K in keyof L["filters"]]?: L["filters"][K] extends readonly (infer V)[] ? V : string;
};

/** Everything a list request can carry: the window, search, sort and the list's filters. */
export type ListQueryOf<L extends ListDef> = PageInput & {
  q?: string;
  sort?: SortOf<L>;
  dir?: SortDir;
} & FiltersOf<L>;
