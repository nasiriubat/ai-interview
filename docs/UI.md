# UI kit and admin shell

How to build an admin page with the shared primitives (D-340 to D-349). Every primitive is shown in
every state at `/dev/ui` (dev servers and the e2e build only; production answers 404). Strings live
in `apps/web/src/i18n/kit.en.ts` and `kit.fi.ts`; both languages are typed to the same shape.

## The shell

`components/admin/AdminShell.tsx` frames every page under `/admin`:

- a rounded **sidebar** panel (collapsible to icons with tooltips; the choice is the `aidp-sidebar`
  cookie, so the server renders the right width and nothing jumps);
- a rounded **content panel** a small gap to its right, fluid to the right edge of the screen;
- a sticky **top bar**: menu or collapse toggle, breadcrumbs, quick search (Ctrl or Cmd + K) and the
  account menu (profile, theme, language, sign out);
- below `lg` (1024 px) the sidebar is a drawer opened from the top bar.

There is no notifications indicator: the product has no alert feed to show. Do not add one until it does.

A page is `PageHeader` plus content:

```tsx
<PageHeader
  title
  subtitle
  actions={<Button />}
  secondaryActions={<ExportMenu />}
  crumbLabels={{ [id]: name }}
/>
```

`crumbLabels` names the id segments of the URL in the top bar's trail. Content may be as wide as the
screen; put a reading column (`max-w-3xl`) inside a page where prose needs one.

**Grid trap.** A `grid` with no explicit columns grows its track to the widest child and pushes the
page sideways. Use `grid-cols-[minmax(0,1fr)]` (or `min-w-0` on the children) around anything that
scrolls: tables, code, long words. `e2e/shell.spec.ts` fails a page that scrolls sideways.

## DataTable (`components/data/DataTable.tsx`)

Server-paginated, server-sorted, URL-synced. A server page passes plain data; nothing in `columns`
or `rows` is a function, so it crosses the server/client boundary.

```tsx
const lp = listParams(await searchParams, LISTS.campaigns);       // validated page, sort, filters
const result = await api.campaigns.list(lp.query);
<DataTable
  id="campaigns" label="Campaigns"
  searchLabel="Search campaigns"
  filters={[statusFilterDef(LISTS.campaigns), dateRangeFilterDef("Dates")]}
  sort={sortOf(LISTS.campaigns)}
  columns={[{ id: "name", header: "Name", sortKey: "name", primary: true, locked: true }, ...]}
  rows={items.map((c) => ({ id: c.id, label: c.name, cells: { name: <Link/> }, actions: <RowActions>...</RowActions> }))}
  page={{ page: lp.page, limit: lp.limit, count: items.length, total: result.total }}
  empty={{ title, description, action }} error={message}
  selectable bulkActions={<MyBulkButton/>} toolbarActions={<ExportMenu/>}
/>
```

- State is the query string (`page`, `limit`, `q`, `sort`, `dir`, filter keys). Any change except the
  page resets to page 1. Rules are pure and tested in `lib/admin/table-state.ts`.
- `bulkActions` is a client component that reads the selection with `useTableSelection()`.
  Selection covers the rows on the current page and is cleared when the rows change.
- Column visibility is a per-viewer convenience kept in `localStorage` (`aidp.cols.<id>`).
- Below `md` each row is a card (the `primary` column is its title). Sorting there is a menu.
- Loading: `loading` or `DataTableSkeleton` in a route's `loading.tsx`. While the URL changes the table
  dims and `aria-busy` is set. Error: `error` shows the message with a retry that refreshes the data.
- Row actions are `IconButton`s: icon only, the accessible name and tooltip say what and for whom
  (`"Disable: kim@example.com"`). A destructive one opens a `ConfirmDialog`.

### Pagination audit

All of these take `limit` (1 to 200, default 50), `offset`, `q`, `sort`, `dir`, their filters, and answer
`{ <key>: [...], total, limit, offset }` (contract 19, `listSpec`): `/users`, `/campaigns`, `/audit`,
`/campaigns/:id/sessions`, `/templates`, `/requirements`, `/budgets`, `/providers/:id/prices`,
`/campaigns/:id/analyses`, `/operator/tenants`.

Not paginated, and why: `/providers` and `/routes` (a handful per tenant), `/prompts` (a fixed set),
`/settings/history` (takes `limit`), `/operator/jobs` (queues, not rows). **`/campaigns/:id/invitations`
is unbounded** (one request may add 1000): it should get a `listSpec` before the invitations list is
moved to `DataTable`.

## Export and import

`ExportMenu` lists the formats the API really serves and sends the table's current search and
filters (not page or size). It shows a loading toast that becomes "ready" or an error with Retry.
Served today: `audit.csv` (D-345), `campaigns/:id/sessions.csv`, the analysis report PDF, and the
specification versions' formats.

`ImportDialog` reads a file in the browser, shows how many rows were understood and which lines were
not (with an error report download), and sends nothing until confirmed. **The API has no bulk import
endpoint.** The one import is a list of addresses for invitations, which feeds the existing
`POST /campaigns/:id/invitations`. Do not add an import button for anything else until an endpoint
exists.

## Forms

`components/admin/forms.tsx` (Field, TextField, NumberField, TextAreaField, SelectField, SwitchField,
ComboField, FormSection, ErrorSummary, ValidatedForm) plus `components/form/`:

- `controls.tsx`: `SecretField`, `UnitField`, `DateField`, `CheckboxField`, `RadioField`, `ReadOnlyField`.
- `useForm({ id, initial, schema, labels, onSubmit })`: values, validation that speaks on blur and on
  submit, dirty flag wired to the leave guard, server field errors, one submit at a time, toast.
  Spread `{...form.field("name")}` into a field.
- `<Form form>`: summary, focus on the first problem, and a floating **save bar** (unsaved or saved,
  Discard, Save). `SaveBarView` is the bar alone for forms that keep their own state (settings).
- `ConfirmDialog`: pass `confirmPhrase` to make a person type it first, for what cannot be taken back.

## FileUpload (`components/upload/`)

`<FileUpload accept maxSizeMb multiple upload={(file, {signal, onProgress}) => ...} />`. Drop or
choose, validated against the limits you pass (take them from the server's settings or the
session capabilities, never constants), per-file progress and cancel, failed files stay in the list
with the reason (too large, type, storage full 507, offline) and a Retry. Progress needs
`XMLHttpRequest`: pass `onUploadProgress` through `request()` (`lib/api/xhr.ts`). The participant's
attachment upload uses it and shows a progress bar with Cancel.

## Toasts and loading

`notify.success | info | error(e, {retry}) | promise(p, {loading, success}) | undo(text, fn)` in
`components/common/notify.ts`. Success 4 s, info 5 s, error 9 s (18 s with a Retry), three stacked,
one live region. Errors that need fixing stay inline. Route loading: `app/admin/loading.tsx`; the
top progress bar runs on in-app navigation and on `useUrlState` changes; buttons take `loading`.

## Motion

CSS transitions only, all neutralised by `prefers-reduced-motion`. A motion library was not added:
there is no motion the shell needs that a transition does not do, and it would cost bundle weight
(D-349).

## Visual review

`pnpm --filter @aidp/web exec tsx scripts/screenshots.ts` writes screenshots of any pages at any
widths, themes and languages (see the header of the script); `scripts/overflow.ts` names what sticks
out past the viewport.

## Participant screens and the diagram viewer (D-380 to D-384)

The participant has no shell: `CenteredShell` frames arrival and status screens, `InterviewScreen` is the chat. Rules that held up in review:

- Mobile first at 360 px. Controls are at least 36 px high (44 on touch); `e2e/participant-layout.spec.ts` enforces it, and fails on sideways scroll.
- Message text uses `[overflow-wrap:anywhere]`; anything a participant or a model wrote can contain a word longer than the screen.
- Failures a person can retry (provider, offline, session expiry) are `Alert variant="warning"`; red is for what is wrong with their input.
- `DiagramViewer` (`components/report/`) is the only way a diagram is shown: zoom, pan, full screen, source.
- `ExportMenu labelled` is the page-header form of the export menu; the icon form is for table toolbars.

Review states: `BASE=http://localhost:3470 OUT=/tmp/shots pnpm exec tsx scripts/review-shots.ts` (`ONLY`, `WIDTHS`, `THEMES`, `LOCALES`).
