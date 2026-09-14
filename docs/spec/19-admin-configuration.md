# 19 Admin configuration surface

Extends contracts 16, 17 and 18. Everything here is staff-facing and tenant-scoped unless it
says operator. Driven by D-31 ("show the numbers, hold the knobs"): every knob is a settings
key, and every configuration screen is generated from the catalog rather than hand-written.

## Secret settings

`SettingDef` gains `secret?: boolean`. A secret value is encrypted at rest with the platform
key (the same key that protects provider credentials) and never leaves the API in plain text.

- `GET /settings` returns the sentinel `"__unchanged__"` as the value of any secret that is
  set, and omits the key entirely when it is not. A parallel map `secrets: { [key]: boolean }`
  says which secret keys hold a value, so the UI can show "set" without showing the value.
- `PUT /settings` treats the sentinel as "leave as it is", any other string as a new value to
  encrypt, and `null` as "clear it".
- The audit diff records the key name and never the value.

## Email settings (new category `email`)

| Key             | Type   | Scopes           | Secret | Meaning                                                |
| --------------- | ------ | ---------------- | ------ | ------------------------------------------------------ |
| `email.smtpUrl` | string | platform, tenant | yes    | `smtp://user:pass@host:587`; empty logs to the console |
| `email.from`    | string | platform, tenant | no     | Envelope sender                                        |
| `email.replyTo` | string | platform, tenant | no     | Optional reply-to                                      |

The email port resolves its configuration per send, tenant first and platform second, falling
back to `EMAIL_SMTP_URL` and `EMAIL_FROM` from the environment when neither is set. A tenant
that sets its own SMTP sends its invitations from its own server. The API and the worker
resolve identically, so a message sent from a job looks the same as one sent from a request.

`POST /settings/email/test` (admin) sends a test message to the calling user's address using
the configuration that is currently in effect for the scope, and returns
`{ ok, usedScope: "tenant" | "platform" | "env", error? }`.

## Scope targets

The scope pickers in settings and budgets must offer names, not ids typed by hand.

| Method | Path               | Query                                  | Response                                            |
| ------ | ------------------ | -------------------------------------- | --------------------------------------------------- |
| GET    | `/settings/scopes` | `scope=template \| campaign \| tenant` | `{ targets: [{ id, name, detail? }] }` newest first |

`tenant` returns the caller's own company, or every company for a platform operator.

## Operator: platform providers and routes

Contract 16 lists these; they were never implemented and the web app 404s on them. They are the
platform-level twins of the tenant routes, operator only, acting on rows with `companyId` null.

| Method       | Path                             | Same shape as           |
| ------------ | -------------------------------- | ----------------------- |
| GET/POST     | `/operator/providers`            | `/providers`            |
| PATCH/DELETE | `/operator/providers/:id`        | `/providers/:id`        |
| POST         | `/operator/providers/:id/test`   | `/providers/:id/test`   |
| GET          | `/operator/providers/:id/models` | `/providers/:id/models` |
| GET/PUT      | `/operator/providers/:id/prices` | `/providers/:id/prices` |
| GET/PUT      | `/operator/routes`               | `/routes`               |

## Models and prices

`GET /providers/:id/models` already asks the provider for its live catalogue and imports any
prices it publishes. The response is now explicit about what happened, so the admin never has
to type a price that the provider already knows:

`{ models: ModelInfo[], importedPrices: number, fetchedAt, stale: boolean, error?: string }`

`ModelInfo` is the shared schema in `packages/shared/src/providers.ts`:
`{ id, name, contextWindow?, inputPerMtok?, cachedInputPerMtok?, outputPerMtok? }`. A provider that
publishes neither a context window nor prices still appears, with those columns empty.
When the provider cannot be reached the route answers `200` with the last imported prices,
`stale: true` and the error text, so the screen degrades instead of failing. A price a provider
does not publish stays admin-editable through `PUT /providers/:id/prices`, and an admin override
is never overwritten by an import (`source: "admin"` wins over `"provider"`).

Routing screens populate their model field from this list for the selected provider.

`GET /providers/:id/prices` answers with rows in the stored shape, paginated:

`{ prices: [{ providerId, model, inputPerMtok, cachedInputPerMtok, outputPerMtok, source }], total, limit, offset }`

`source` is `seed`, `provider` or `admin`. `PUT /providers/:id/prices` takes
`{ prices: [{ model, inputPerMtok, outputPerMtok, cachedInputPerMtok? }] }`; an omitted
`cachedInputPerMtok` is stored as `inputPerMtok`, the whole batch is written in one transaction,
and every row it writes becomes `source: "admin"`.

`POST /providers/:id/test` takes an optional `{ model? }`. Without one it tests the model of the
newest route pointing at this provider, then the first model the provider lists, and answers `400`
when neither exists. The response names the model it used.

## Pagination

Every staff list that can grow without bound takes `limit` (1 to 200, default 50) and `offset`
(default 0) and answers with the list plus `{ total, limit, offset }` beside it. The list key
keeps its current name so existing clients keep working.

Paginated: `/audit`, `/campaigns`, `/campaigns/:id/sessions`, `/requirements`, `/users`,
`/budgets`, `/providers/:id/prices`, `/operator/tenants`, `/campaigns/:id/analyses`.

Not paginated, because the row count is bounded by the catalogue: `/routes`, `/templates`,
`/settings`, `/providers`, `/stats`, `/spend`.

## Web conventions

- **Settings** is one screen per category, listed in a sidebar beside the form, each category
  submitting on its own. A category shows which scope each value came from and offers a reset
  to the inherited value.
- **Searchable dropdowns** wherever the list is not a fixed short enum: scope targets, budget
  targets, models, providers, templates. Built on the existing popover primitive; typing
  filters, the keyboard works, and the current value is always visible.
- **Action buttons in tables are icons** with a tooltip and an accessible name; destructive
  actions keep their confirmation dialog.
- **Required fields** are marked with a red asterisk that is hidden from screen readers, which
  read the native `required` instead.
- **Paginated tables** show "x to y of n" with previous and next, and keep the page in the URL
  so a reload and a shared link land in the same place.
