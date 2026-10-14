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

## Results and operator pages (D-370 to D-379)

What was added to the kit for the analysis workspace and the configuration and operator pages, and
how to review them.

### Charts (`components/admin/charts/`)

- `ChartPanel`: a `Panel` with a Chart or Table switch over the same numbers. Give it `chart` and a
  `table`; omit `table` for a chart that is already a table. Print shows the chart.
- `StackedBar`: one proportional bar and its legend (name, count, share). The legend is the text
  equivalent; the bar is an `img` with a label that lists the numbers.
- `HeatMatrix`: a `<table>` whose cells are tinted by magnitude and print their number; a cell can
  be `withheld`. The first column sticks and the rest scrolls inside the card on a phone.
- `BarList` (existing): ranked bars with the value printed at the end of each.
- `Withheld`: the mark for a value the anonymity rule keeps back. Use it instead of an empty cell or
  a zero. Pass the reason; it is read by assistive technology and is the tooltip.
- `palette.ts`: `CLASS_COLOR`, one token per solution class. Colour never carries the class alone.

`QuoteBlock` (`components/admin/`) is a `figure` with a `blockquote` and a caption that says it is
an interview excerpt, whether it was anonymised, and the fact it came from. Never a name.

`DownloadButton` (`components/data/`) downloads one file from the staff proxy with the toast
sequence of `ExportMenu`; icon-only in a row, labelled with `text`.

### The results workspace

`app/admin/campaigns/[id]/results/page.tsx` loads; `components/admin/results/ResultsView.tsx` is the
client. Sections are in `?tab=` (`lib/analysis/tabs.ts`). `OpportunityRow` is one row;
`OpportunityPanel` is the side panel (a `Sheet`); `WeightsPanel` is a sheet. The filter bar sticks
at `top-14` (`lg:top-[4.25rem]`) under the top bar: keep it a direct child of the tab content.

A server page can hand the client a table: the versions list is a `DataTable` element passed as
`versions`.

### Reviewing a state

States that a plain load does not reach are scenarios of the fake API (`e2e/review-data.ts`). The
scenario and the role are claims of the session token (`e2e/fake-api.ts`), so a spec mints its own:

```ts
const value = await encode({
  token: { email, sub: "u1", role: "platform_operator", scenario: "withheld" },
  secret,
  salt,
});
```

`e2e/pages.ts` takes `scenario` on an entry (`adminIn`, or the fourth argument of `operator`), so
axe and the CSP check run on the empty, withheld, long, running and error versions of a page.

The review matrix:

```
BASE=http://localhost:3641 OUT=/tmp/review SHOTS='^results-' WIDTHS=390,1280 THEMES=light,dark \
  LOCALES=en,fi pnpm exec tsx scripts/review-shots.ts
```

`scripts/overflow.ts` names what makes a page scroll sideways. It skips what a scroller clips, but
not an absolutely positioned child of a scroller that is not its containing block, which is how a
`sr-only` header cell once did (the scroller is now `relative`).
`e2e/workspace.spec.ts` asserts the geometry: nothing scrolls sideways, the filter bar sticks, the
side panel stays on screen, withheld values are marked, the paper is a page wide, a row action
names itself, offboarding needs the name typed.

### Statements, exports and offboarding

`/admin/budgets/statements[/yyyy-mm]`, `/admin/operator/statements` and
`/admin/operator/tenants/:id`. A statement is frozen: it is never recalculated, and estimated cost is
marked as an estimate (`includes estimate`). Offboarding follows D-226: the tenant must be suspended,
its name is typed, and the person is told the date.
