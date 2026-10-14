# @aidp/web

The Next.js web app of the AI Discovery Platform: the participant interview on the
public side, the staff admin under `/admin`. It talks only to the API contracts
(`docs/spec/16-api-contract-phase1.md` and `17-api-contract-phase2.md`); it never
touches the model or the database.

## Stack

Next.js 16 (App Router, `output: "standalone"`), React 19, TypeScript strict
(`exactOptionalPropertyTypes` on), Tailwind CSS v4, shadcn-style components on
`radix-ui`, Auth.js v5 (`next-auth@beta`) with Google and email magic links on the JWT
strategy, zod 4 (schemas imported from `@aidp/shared`), Vitest + Testing Library.
Phase 2 adds `react-markdown` + `remark-gfm` for the report and `mermaid` (loaded on
demand in the browser) for the process maps.

The shadcn registry (`ui.shadcn.com`) was not reachable from the build environment, so
the components under `src/components/ui/` are written by hand in the shadcn "new-york"
style on top of the `radix-ui` umbrella package. `components.json` is in place so the
CLI can add more later.

## Run

```sh
cp .env.example .env                       # at the repo root: fill AUTH_SECRET, Google, SMTP
pnpm install
pnpm --filter @aidp/shared build            # the web app imports the built package
pnpm --filter @aidp/web dev                 # http://localhost:3000
```

Scripts: `dev`, `build`, `start`, `typecheck` (`tsc --noEmit`), `lint` (root ESLint
config), `test` (Vitest, jsdom).

Docker (from the repository root): `docker build -f apps/web/Dockerfile .` produces a
standalone image listening on port 3000.

Environment: `NEXT_PUBLIC_API_URL` (API origin, `/api/v1` is appended), `AUTH_SECRET`
(shared with the API so it can decode the Auth.js JWT), `AUTH_GOOGLE_ID`,
`AUTH_GOOGLE_SECRET`, `EMAIL_SERVER`, `EMAIL_FROM`, and `NEXT_PUBLIC_VOICE_WS_URL`
(optional; the live voice socket, which is the one call the browser makes itself — empty
in production, where it is same-origin).
`NEXT_PUBLIC_CONTACT_EMAIL` (optional; the address behind "Request a workspace" on the public
landing page `/`. Unset or not a plain address: the page shows no mail link, only sign-in. It is
read at runtime, so it can be set without a rebuild.)

## Structure

````
src/proxy.ts                     Auth.js gate for /admin/* (Next 16 "proxy", formerly middleware)
src/auth.ts, src/auth.config.ts  Auth.js: Google + Nodemailer, JWT sessions, in-memory adapter
src/i18n/en.ts                   every user-facing string; the type source for other languages
src/i18n/fi.ts                   Finnish, typed as `Strings` so a missing key fails typecheck
src/i18n/locale.ts               supported locales, `lang` cookie, Accept-Language resolution (pure)
src/i18n/index.ts                `t`: a deep proxy resolving each string against the active locale
src/i18n/server.ts               `requestLocale()` / `getStrings()` for server components and metadata
src/i18n/LocaleProvider.tsx      publishes the locale to client components
src/lib/i18n/enums.ts            `label(kind, value)`: names for API and shared-enum identifiers, settings
                                 keys and the options of enum-valued settings (reads `t.enums`; D-132)
src/lib/env.ts                   API base URL, cookie names, the live voice socket URL
src/lib/api/
  errors.ts                      ApiError + `{ error: { code, message } }` unwrapping
  http.ts                        Transport abstraction, request() with zod validation, requestStream()
  schemas.ts                     zod response schemas (exact where the contract is, tolerant elsewhere)
  sse.ts                         SSE parser and the typed turn stream
                                 (text | turn | ended | spec | transcript | error)
  voice-live.ts                  zod frames of the live voice socket (FR-30a), both directions
  participant.ts, staff.ts       every endpoint of contracts 16 and 17, transport-agnostic
  server.ts                      server-side transports: Bearer token read from httpOnly cookies
  browser.ts                     browser clients that go through the /api/* proxies
  proxy.ts                       shared forwarding logic for the route-handler proxies
src/lib/analysis/rank.ts         client-side re-ranking with `rankScore` from @aidp/shared, presets,
                                 effective title/class/factors under admin overrides
src/lib/analysis/override.ts     reducer for the override sheet and the minimal PATCH payload
src/lib/report/mermaid.ts        splits report Markdown into Markdown and ```mermaid segments
src/lib/report/sections.ts       maps report sections to Markdown chunks for the section toggles
src/lib/admin/discoveryStats.ts  recognizes discovery tiles in `/stats` (by class, top by rank)
src/lib/admin/pagination.ts      `?page=` -> limit/offset, the "x to y of n" range, next-page test
src/lib/admin/settingInput.ts    which control renders a settings key (secret, weights, enum, …)
src/app/page.tsx                  the public landing page (server component, no client JS of its own);
                                 words in src/i18n/landing.{en,fi}.ts, claims in docs/team/claims-2026-10.md
src/app/robots.txt, sitemap.xml  crawler files; only `/` may be indexed
src/app/api/participant/[...path]   proxy: moves participant tokens into the `aidp_participant` cookie
src/app/api/staff/[...path]         proxy: attaches the Auth.js JWT as `Authorization: Bearer`
src/app/api/preview/[templateId]    admin template preview: cookie + redirect to /p/session
src/app/api/auth/[...nextauth]      Auth.js handlers
src/app/p/[linkToken]            arrival, email code, details, consent, path selection
src/app/p/session                the interview (streaming, widgets, progress, menu, summary)
src/app/auth/*                   sign-in, verify-request, error pages
src/app/admin/*                  dashboard, templates, campaigns, sessions, settings, providers,
                                 routes, budgets, users, audit, operator/*
src/app/admin/campaigns/[id]/results   analysis header, weights, filters, opportunity cards, compare
src/app/admin/campaigns/[id]/report    the organization report (Markdown + Mermaid, sections, print)
src/hooks/useInterview.ts        optimistic messages, SSE streaming, progress, ending, errors
src/hooks/useRecorder.ts         MediaRecorder: permission on demand, 5 min cap, tracks always released
src/hooks/useLiveVoice.ts        the live call: socket, silence detection, barge-in, playback, fallbacks
src/hooks/useAttachments.ts      upload, remove, play back, poll a pending attachment until it is read
src/hooks/useAnalysisPolling.ts  polls the latest analysis every 5 s while queued or running
src/hooks/useOnline.ts           `navigator.onLine` as external store (gates Retry, never proves reachability)
src/hooks/useMediaQuery.ts       `useCoarsePointer`, `usePrefersReducedMotion`
src/hooks/useDebouncedSave.ts    persists a knob a moment after it stops changing
src/components/ui/*              shadcn-style primitives (phase 2 adds `sheet`, contract 19 `combobox`)
src/components/common/*          language switch, `EnumLabel`, `PageHeading` (focus on step change), `ConfirmDialog`,
                                 `undoToast`, `DirtyGuard` (D-111, D-112)
src/components/widgets/*         single_choice, multi_choice, scale, ranking, yes_no + renderer
src/components/participant/*     arrival flow, message list, composer (typing, microphone, paperclip),
                                 attachment list, mode switch, progress, menu, summary,
                                 live voice call panel
src/components/admin/*           shell, forms, template editor, campaign panels, settings, providers,
                                 dashboard discovery tiles
src/components/admin/results/*   analysis header, weights panel, filters, opportunity card, factor bars,
                                 override sheet, promote dialog, compare versions
src/components/report/*          ReportView, ReportMarkdown (react-markdown), MermaidDiagram
test/                            Vitest: widgets, SSE reader, API error wrapper, interview hook,
                                 locale resolution + `t` proxy, rank/override, Mermaid + sections,
                                 combobox, pagination, icon buttons, settings category form,
                                 paginated list schemas, recording and attachments,
                                 the live voice call (socket, silence, barge-in, fallbacks),
                                 server locale per page, tokens and contrast, announcer and
                                 mode switch, confirmations and undo, form errors and dirty guard
````

Server components load data directly from the API with the cookie token; client
components mutate through the proxies and call `router.refresh()`.

### Languages

`en.ts` is the type source; `fi.ts` is declared as `Strings`, so a missing or extra key
fails `tsc`. Components keep importing `t` from `@/i18n`: it is a deep proxy whose leaves
resolve against the active locale when read, so module-scope shortcuts such as
`const s = t.admin.campaigns` stay correct.

The locale is the `lang` cookie when set (written by the language switch in the admin
shell and the participant headers, then `router.refresh()`), else the first supported
language in `Accept-Language`, else `en`. The root layout resolves it once per request
(`requestLocale()`), sets `<html lang>`, stores it in a per-request React `cache` store
for server components and hands it to `LocaleProvider` for client components. Page titles
use `generateMetadata` with `getStrings()` because static `metadata` exports are
evaluated at module load. Dates and numbers format with `Intl` in the active locale.

Rules that keep the Finnish page Finnish (D-118): every server `page.tsx`, `not-found.tsx`
and `loading.tsx` (and nested layouts) starts with `await requestLocale()`, because the layout
that fills the store does not run before a page that reads strings; `test/server-locale.test.tsx`
renders pages without the layout and fails a new page that forgets. A label read at module load
(`const NAV = [{ label: t.x.y }]`) takes the first importer's locale for ever, so labels are
built inside a function called during render.

Content: the voice, the glossary and the error and empty-state rules are in
`docs/design/content-guide.md` and `docs/design/glossary.md`. An identifier that comes from the
API or a shared enum is never spelled out by machine: it goes through `label()` and `t.enums`
(D-132), and a participant never reads an API message but the three-part text that
`participantErrorFor` picks from the error code and the screen (D-134). `test/enums.test.ts`,
`copy-length.test.ts`, `copy-truth.test.ts` and `localized-screens.test.tsx` hold this in place.

Known limit: on the server, client components share one module-level locale variable
during SSR; two concurrent requests in different languages could in theory interleave at
a Suspense boundary. The RSC side is per-request and unaffected.

### Results and report (phase 2)

`/admin/campaigns/[id]/results` loads the campaign, its analyses (newest first), the
selected one (`?version=<analysisId>`, default latest) and the campaign-scope settings.
Ranks are recomputed in the browser with `rankScore` from `@aidp/shared` whenever the
weights change; the preset and vector are saved to `analysis.weightsPreset` /
`analysis.weights` at campaign scope after a short debounce. Admin overrides
(`adminOverride`) are applied client-side over the generated title, class and factors so
the same code path renders API answers whether or not the API already merged them.

`/admin/campaigns/[id]/report` renders `report.markdown` with react-markdown (GFM, no raw
HTML) and turns ```mermaid fences into SVG in the browser (`securityLevel: "strict"`;
render errors fall back to the source). Section checkboxes hide chunks immediately and
persist to `analysis.reportSections` at campaign scope. "Download Markdown" writes the
visible Markdown to a Blob; "Print" uses the browser's print with a print stylesheet
(navigation, toolbars and controls carry `print:hidden`).

### Voice and files (phase 4)

The composer can record and can attach a file; both are optional props, so the owner-side
requirements workspace keeps the plain text composer. A recording is one request:
`POST /p/session/voice-turns` uploads the audio and streams the turn back, opening with
`event: transcript`, which `useInterview` shows as the participant's own message before the
interviewer's reply. The microphone is requested when the button is first pressed and never
on load; the tracks are stopped on stop, discard, the five-minute cap and unmount. A denied
permission, a browser without `MediaRecorder` and a missing microphone each get their own
sentence, and typing stays available under all three.

Files go to `POST /p/session/attachments` as multipart (`http.ts` passes a `FormData` body
through so the browser sets the boundary). The list above the composer is seeded from
`session.attachments`, shows each file as pending, ready or failed with the reason, and polls
every 3 s while anything is pending, because ingestion is a job. A recording is played by
fetching its bytes through the proxy into a blob URL, which is revoked when the player
unmounts.

What is offered comes from `session.capabilities`: the microphone and the voice mode appear
only when `recordedVoice` or `liveVoice` is true, the paperclip only when `fileUpload` is
true, and the picker's `accept`, the type check and the size check follow `allowedTypes` and
`maxSizeMb`. Nobody learns from a 403 that they should not have spoken.

**Every recording is converted to WAV before upload (D-75).** Chrome and Firefox record
WebM/Opus and Safari records AAC in MP4, and the server's own Whisper cannot read either without
ffmpeg. So `useRecorder` hands each finished recording to `toSpeechWav` (`src/lib/audio/wav.ts`):
`decodeAudioData`, then an `OfflineAudioContext` at 16 kHz mono, then a 16-bit PCM WAV header.
That is exactly what Whisper listens to, so nothing is lost, and a minute is about 1.9 MB
(five minutes, the cap, is 9.6 MB — under the default 20 MB `files.maxSizeMb`, so a tenant that
lowers it below 10 MB shortens the longest answer that fits). When the browser cannot decode its
own recording the original blob goes up instead: a cloud `transcription` route still reads it,
and the on-server one answers with a sentence telling the participant to type. The stored WAV
plays back in every browser.

Out of the box the `transcription` route points at **"On this server (Whisper)"**, a `local`
provider that bootstrap always creates, so recording needs no API key and the audio never leaves
the VPS. The API runs Whisper through transformers.js on a worker thread, one recording at a
time, with the model cached in the `models` volume. Measured on an Apple-silicon laptop with the
real pipeline (whisper-small, q8, the default):

| What                                               | Result                                    |
| -------------------------------------------------- | ----------------------------------------- |
| First load, including the 250 MB download          | 8.6 s on a fast connection                |
| Load from the cache on a restart                   | 0.9 s                                     |
| 10 s Finnish answer, language detected             | 1.3–1.8 s, word-perfect but for one split |
| 10 s Finnish answer, two CPU threads only          | 1.6 s                                     |
| 35 s Finnish answer                                | 5.0 s                                     |
| 8 s English answer, 44.1 kHz stereo WAV            | 1.2 s, word-perfect                       |
| Resident memory of the whole process while it runs | 1.6–2.0 GB (0.9 GB once loaded and idle)  |
| API event loop during a transcription              | never blocked more than 8 ms              |

A 2-vCPU VPS core is slower than a laptop core; expect roughly three to four times these times,
still well inside the run timeout (a minute plus the length of the audio). Whisper-base is twice
as fast in half the memory but made four mistakes in the same Finnish sentence; large-v3-turbo
is on the list for a server with 4+ GB to spare.

The language is not forced. transformers.js silently assumes English when it is not told, and
Whisper then _translates_ a Finnish answer into English, so the thread runs Whisper's own
language identification first, restricted to the interview's language plus Finnish and English
(`speechLanguages`) so that a one-word answer cannot be heard as Estonian.

Live voice still streams WebM, so with the on-server route it falls back to the record button
(`reason: "transcription_needs_wav"`), which works; a cloud route keeps it live.

### Real-time voice (FR-30a)

With `capabilities.liveVoice` on, choosing the voice mode opens a call instead of showing a
record button. `useLiveVoice` owns the socket, the microphone, the end-of-utterance detector
and playback; `LiveVoiceCall` shows what is happening and `useInterview.live` folds the
result into the same message list, so a session answered by voice reads afterwards exactly
like one that was typed.

As soon as the socket is ready the client sends `{type:"speak_last"}`, so the question
already on screen is read aloud and entering a call halfway through an interview sounds
like picking up a phone rather than like silence. It takes no turn and stores nothing, so
it is also what a reconnect sends.

The socket is the one API call the browser makes itself — a WebSocket cannot go through a
Next.js route handler, so Caddy forwards `/api/v1/p/session/live` to the API and the
`aidp_participant` cookie authenticates it. `NEXT_PUBLIC_VOICE_WS_URL` names it in
development, where the API is on another port; in production the URL is derived from
`location`.

The server's `ready` frame names how it hears (D-77). In `mode: "stream"` (the tenant has an
`stt_stream` route) an AudioWorklet (`lib/voice/pcm-worklet.ts`, loaded from a Blob URL)
resamples the microphone to 24 kHz mono PCM16 and sends 80 ms binary frames for the whole call.
The server pipes them to OpenAI's realtime transcription and sends `caption_partial` (the whole
growing text, not deltas) while the participant talks, `speech_started`/`speech_stopped` from the
provider's voice detection, and `caption_final` when the utterance is done, which it then answers
as a turn. The hook shows the partial in `live.partial`; `LiveVoiceCall` renders it with
`aria-live="off"`, because it changes several times a second, and the final caption is announced
once by the message list. A `speech_started` while the interviewer is talking is barge-in; its
`barged` flag says whether the server already cut synthesis, so the browser only sends `barge`
when it did not. With barge-in off, no frames are sent while the interviewer speaks. A browser
without AudioWorklet sends `{type:"capture", mode:"utterance"}`, and a server whose streaming socket
dies sends `{type:"mode", mode:"utterance"}`; either way the call carries on with recordings, and
the browser acknowledges with `capture` so the server stops discarding PCM still in flight.

In `mode: "utterance"`, hands-free comes from an `AnalyserNode` on the microphone stream, polled
every 50 ms: speech above an RMS threshold starts a `MediaRecorder`, ~900 ms of quiet afterwards
stops it and sends `{type:"utterance"}`. One recording per utterance, not one continuous stream,
because the server treats each utterance as a complete webm file and only the first slice of a
stream carries the container header. Nothing is sent when the room was never above the threshold.
Barge-in needs a higher level held for three polls, since the speakers feed the microphone
(`echoCancellation` is requested for the same reason); the "stop the interviewer" button
works regardless of the tenant's `voice.bargeIn` setting.

The interviewer's audio is buffered per `speech_start`/`speech_end` pair and played from a
blob URL, so speech starts when synthesis finishes rather than when the first byte lands.
`MediaSource` would start sooner but needs codec-exact mime strings and is missing on iOS
Safari, where a mismatch fails silently; the server measures `first_word` from its own side,
so the spec's latency target is still traced honestly.

Fallbacks are the spec's chain, and `unavailable.fallback` says which rung is still standing.
`captions` keeps the call and stops waiting for audio. `recorded` means transcription failed
but the route exists, so the call ends and the push-to-record button comes back. `text` means
there is no transcription route at all — recorded voice goes through that same route, so the
microphone and the voice mode are both withdrawn, the mode moves to chat and the participant
is asked to type; sending them at the microphone there would be the one suggestion guaranteed
to fail. A value this client does not recognize is read as `text` for the same reason: typing
is the only rung that cannot itself be the broken thing. The hook reports `recorded` or `text`
through `onUnavailable` and decides nothing about the UI; the screen picks what to offer.

A socket that closes unexpectedly is reopened once, and a second close falls back to
`recorded` — the cascade is presumably fine, it was the connection that went. Every one of
those paths, plus end, unmount, a refused permission and the interview ending, runs through
the same `release`, so the microphone is never left open.

Admins turn live voice on from the **Live voice calls** panel at the top of Settings → Voice
(tenant scope, `LiveVoicePanel`). It reads `GET /admin/voice/readiness` and shows a checklist of
speech-to-text, streaming captions and the interviewer's voice with the provider and model in
force. Switching it on when a required route is missing opens a dialog for an OpenAI key
(`POST /admin/voice/openai`, a password field, the error shown inline next to it), then turns the
switch on (`PUT /admin/voice/live`); a `voice_not_ready` answer from a stale page opens the same
dialog.

Captions are the participant's own words: the server takes the turn with the answer already
transcribed, so no `turn` frame echoes them. The interviewer's caption repeats the `turn`
frame that precedes it and is dropped, which is what keeps each exchange in the list once.

### Design system (D-78)

One light theme modelled on Stripe, defined as tokens in `src/app/globals.css` and nowhere else:
an off-white canvas (`--background`), white cards lifted by `--shadow-card`, navy text
(`--foreground` for headings, `--body` for copy), one indigo accent (`--primary`, 4.7:1 with white),
and soft status pairs (`success-soft`, `warning-soft`, `destructive-soft`, `info-soft`) whose text
colour clears AA on their own background. Inter is self-hosted by `next/font`, so no page makes a
request to Google. Components use the semantic tokens only; a dark theme later is a second block.

Non-text contrast and focus (D-110): a form control's boundary is `--input` (`#7f8a99`, 3.5:1 on
white, 3.3:1 on the canvas; hover `--input-hover`), drawn by `--shadow-control`; buttons are
identified by text and fill and keep the decorative `--shadow-button`. Focus is the one rule in
`globals.css` (`:focus-visible`, 2px solid `--ring`, offset 2px); components do not set their own
rings or `outline-none`. `@media (prefers-reduced-motion: reduce)` shortens every animation and
transition globally, and spinners are `motion-safe:`. `test/tokens.test.ts` reads the tokens from
the stylesheet and fails if a pair drops under 3:1 or a component brings back a raw hex value.

Which piece to reach for:

| Need                              | Use                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| Page title, subtitle, actions     | `PageHeader`, with `crumbLabels={{ [id]: name }}` on any page with an id in its URL         |
| A titled box (table, list, chart) | `Panel`; `Card` for padded free-form content                                                |
| A headline number                 | `StatTile` (optionally with a lucide icon)                                                  |
| Ranked magnitudes, a funnel       | `charts/BarList`: one hue, values printed, a `<ul>`, so it needs no separate table          |
| A value over the last N days      | `charts/DailyColumns`: hover tooltips, and a hidden table for assistive tech                |
| Nothing to show                   | `EmptyState`                                                                                |
| Something finished                | a toast: `useAction().run(fn, "Saved")`, or `toast.success` from `components/ui/sonner`     |
| Something failed                  | inline, next to its form: `<Flash flash={action.flash} />`; never a toast                   |
| A button that starts async work   | `<Button loading={busy}>`; in a server-action form, `SubmitButton`                          |
| Picking from a list that can grow | `Combobox` (searchable, keyboard-driven); `Select` or a native select for short fixed lists |
| A page that is one centred card   | `CenteredShell` (sign-in, arrival, status pages)                                            |
| Asking before an irreversible act | `ConfirmDialog`: title asks, body names the consequence, confirm repeats the verb (D-111)   |
| A reversible act                  | do it, then `undoToast(text, undo)`; deferred work uses `options.onClose` (D-111)           |
| A form that validates on submit   | `ValidatedForm` + `FormIssue`s + `SubmitStatus`; `useDirty(id, dirty)` (D-112, D-117)       |
| A heading that takes focus        | `PageHeading focusOnMount` on a screen that replaces another in place                       |

A table is a card on its own: `globals.css` gives `[data-slot="table-container"]` the card surface
unless it already sits in a card, so no page wraps tables by hand. `NavigationProgress` (root
layout) draws the top loading bar on internal link clicks and finishes when the URL changes;
code that navigates with `router.push` calls `startNavigationProgress()` first. Every admin route
shares one skeleton (`app/admin/loading.tsx`) shaped like a title over a table.

"Listen" under each interviewer message is the browser's own speech synthesis (`useSpeech`,
`lib/speech.ts`, D-76): free, keyless, nothing leaves the device. It is offered only when the
browser has a voice for the interview's language, prefers the platform's natural voices, and
queues sentence-sized pieces because Chrome drops utterances longer than about fifteen seconds.

### Tokens never reach client JavaScript

- Participant: `verify/confirm` and `open` are proxied; the proxy strips
  `participantToken` from the response and sets it as the `aidp_participant` httpOnly
  cookie. All `/p/session/*` calls (including the SSE turn stream) go through the proxy,
  which adds `Authorization: Bearer pt.<token>`. `DELETE /p/session` clears the cookie.
- Staff: the Auth.js session cookie (`authjs.session-token`, a JWE) is forwarded as
  `Authorization: Bearer` by server components and by the `/api/staff` proxy. Platform
  operators may send `X-Company-Id`; the proxy passes it through.

### Accessibility

Mobile-first layouts, a solid 2px focus outline, skip link, labeled controls, keyboard-operable
widgets (arrow keys on the scale, up/down buttons on the ranking), reduced-motion safe typing
indicator, dialogs with focus management from Radix. The interview announces a turn once, when it
is complete (D-114): the conversation is an `<ol>`, the streaming bubble is `aria-live="off"`, and
one `role="status"` region receives the finished text, with the kind of widget under it. The answer
mode is a toggle group (arrows move focus, Enter chooses; D-115). `Alert` takes `role="alert"` for
what blocks the person and `role="status"` for the rest. A step or status screen moves focus to its
`h1`. A failed form submit moves focus to the first invalid field and lists the problems (D-117). In a live voice call the phase (connecting, listening,
thinking, speaking) is announced through `role="status"`, the level meter is decorative
(`aria-hidden`, and its bars differ in height as well as colour), the spinner and the meter's
transition are `motion-safe:` only, and ending the call or switching to typing is always one
visible, focusable button away — focus moves to "end the call" when it opens and back to
"start a voice call" when it closes.

## Contract gaps

Things the web app needs that `16-api-contract-phase1.md` does not spell out. Each is
implemented with an assumption and is easy to adjust once the API lands.

1. **Skip / come back to an area.** No endpoint exists. The progress indicator sends a
   text turn `"Let's skip this for now (<area>)"` or `"Let's come back to <area>"`
   (strings in `src/i18n/en.ts`). TODO: replace with a dedicated endpoint when one exists.
2. **"I'm done" flow.** The contract says `POST /p/session/complete` "triggers closing on
   next turn". The app posts `complete` and then sends a text turn `"I'm done"` so the
   closing question streams immediately. TODO: confirm the API expects a follow-up turn.
3. **`consentVersion`.** Not returned by `GET /p/:linkToken`. The app sends a stable hash
   of the consent text shown (`consentVersion(text)` in `ArrivalFlow.tsx`). TODO: expose
   the version on the link payload.
4. **Verification errors.** The app maps 400/401/403 on `verify/confirm` to "invalid
   code" and recognizes an optional `domain_not_allowed` error code. TODO: agree on codes.
5. **`GET /stats` and `GET /operator/stats` shape.** Not specified; the dashboard renders
   any groups of numeric values generically (`StatsGroups`). Known group keys get labels
   (`participation`, `ai`, `discovery`, `requirements`, `health`).
6. **List envelopes.** For lists without a spelled-out shape (templates, campaigns,
   invitations, sessions, users, providers, budgets, audit, tenants, models, prices) the
   client accepts either a bare array or `{ items | rows | entries | data | <name>: [] }`.
   Single records accept either the bare object or `{ template | campaign | session |
provider | tenant: {...} }`.
7. **Template records.** Assumed `InterviewTemplate` fields plus `id`, `companyId`
   (null for shipped), `status: draft | published | archived`, timestamps. The list is
   allowed to be lighter (id, key, name, version, companyId, status, updatedAt).
8. **Campaign records.** Assumed `templateKey`, `stats`, `link` as in the contract's
   detail response; `verification` and `participationMode` echoed back.
9. **Session list rows.** Assumed `costCents`, `progress`, `participantEmail?` (only when
   identified), `updatedAt`. Staff session detail assumed `messages?` (omitted or empty
   when the privacy setting hides transcripts) and `campaignId?`.
10. **Settings catalog** carries no type. Input kinds come from the shared `SETTINGS`
    zod schemas by key; unknown keys fall back to the type of `default`.
11. **`/providers/:id/models`** "imports prices": the app treats the response as a list of
    `ModelInfo` and merges it into the editable price table, then `PUT /prices` with
    `{ prices: ModelInfo[] }`. TODO: confirm the PUT body.
12. **`/routes` PUT** sends `{ routes: Route[] }` with the tenant's `companyId` (or null
    for platform defaults); rows without a provider mean "inherit".
13. **`/budgets`** POST sends a `BudgetLimit`; rows are assumed to carry an `id` for DELETE.
14. **`/audit`** rows: assumed `createdAt | at`, `actor | actorEmail | userId`, `action`,
    `target | targetType + targetId`, `diff | details`.
15. **`/operator/tenants`** rows: assumed `id, name, status?, region?, defaultBudgetCents?,
createdAt?`; PATCH with `{ status: "suspended" | "active" }` to suspend/activate.
16. **`/operator/providers/:id/{test,models,prices}`** are assumed to mirror the tenant
    routes.
17. **Auth.js email provider** needs verification-token storage; the API has no such
    endpoint, so `src/lib/auth/adapter.ts` keeps tokens in memory (single instance).
    Roles are not in the JWT: `/admin` layouts resolve them via `GET /me`. Any Google
    account can sign in to the web app; the API decides who is staff (401/403 → "no
    access" banner).
18. **Session `status` values** assumed from the state diagram in `10-architecture.md`:
    `created, consented, active, paused, completed, deleted`.
19. **Voice mode** is live in phase 4: `POST /p/session/mode` now also takes `voice`, which
    makes the microphone the primary control and keeps typing beside it.

Phase 2 (`17-api-contract-phase2.md`):

20. **Report sections in the Markdown.** The contract lists `report.sections` but does not
    say where each section starts in `report.markdown`. The web recognizes
    `<!-- section: <key> -->` comment lines when present; otherwise the n-th level-2
    heading (`## `, outside code fences) is taken to be the n-th entry of `report.sections`.
    Content before the first section is always shown; headings beyond the list are
    always shown. TODO: agree on markers.
21. **Override PATCH semantics.** The web sends the full current override (fields equal to
    the generated values are omitted) and assumes the API _replaces_ the stored override;
    an empty body `{}` means "remove the override". Whether the returned `factors` already
    have overrides merged is not specified; the web merges `adminOverride.factors` over
    `factors` client-side, which is idempotent either way. Factor overrides without a
    rationale are sent with the generated rationale (the shared schema requires one).
22. **Analysis detail while queued.** `GET /analyses/:id` is only called for runs that are
    not `queued`; for `running`/`failed` runs the web tolerates empty `opportunities` and a
    null `report`. `stats.embedding` (`provider | lexical`) and `stats.error` are optional.
23. **`/stats` discovery tiles.** Rendered only when recognized:
    `discovery.opportunitiesByClass` (`{ ai, automation, software, process, none }`, also
    accepted as `byClass` / `bySolutionClass`) and `discovery.topOpportunities`
    (`[{ id?, title, rankScore, solutionClass?, campaignId?, campaignName? }]`, also
    `topByRank` / `top`), either under `discovery` or at the top level. Anything else goes
    through the generic renderer.
24. **Settings at campaign scope.** `GET /settings?scope=campaign&scopeId=<id>` may return
    only the overrides set at that scope; missing keys fall back to the shared defaults
    (`balanced`, weights of 1, all report sections). Weights are saved together with the
    preset every time, even when the preset is a shipped one.
25. **Promote.** After `POST /opportunities/:id/promote` the web marks the opportunity
    `promoted` locally and links to `/admin/requirements/<session.id>` (the phase 3
    workspace). `handoff` is validated with the shared `HandoffSchema` (all fields required).
26. **Diff.** `changed` pairs are keyed by `after.id` in the UI; ranks in the diff are the
    API's (stored weights), not re-ranked client-side.
27. **Language.** The UI language is the `lang` cookie / `Accept-Language`; it is not sent
    to the API. `analysis.language` (the report's language) stays a separate setting.

Contract 19 (`19-admin-configuration.md`):

35. **Clearing a settings override.** Each settings category submits on its own and sends only
    its own keys, so "reset to the inherited value" cannot be expressed by leaving a key out.
    The web sends `null` for that key, the same sentinel the contract defines for clearing a
    secret. Keys already set at this scope are re-sent unchanged; a key that is only inherited
    is not sent at all.
36. **`sources`.** The contract says a category must show which scope each value came from but
    names no field for it. The web reads an optional `sources: { [key]: scope }` beside
    `values` / `effective` and, when it is absent, falls back to "set here" when the key is in
    `values` and "inherited" otherwise.
37. **Pagination in the UI.** `/providers/:id/prices` is fetched at the maximum page size (200)
    and merged with the provider catalogue into one table, so that screen has no page control;
    `/campaigns/:id/analyses` feeds the version picker on the results page rather than a table,
    so it has none either. Every other paginated list (`/audit`, `/campaigns`,
    `/campaigns/:id/sessions`, `/requirements`, `/users`, `/budgets`, `/operator/tenants`) keeps
    its page in `?page=` and renders "x to y of n". Without `total` the count is hidden and
    "next" is offered only while a full page came back.
38. **Price rows vs. catalogue models.** `GET /providers/:id/prices` is keyed by `model` and
    carries `source: seed | provider | admin`; `GET /providers/:id/models` is keyed by `id` and
    carries `contextWindow`. The models screen merges the two by model id; `contextLength` and
    `maxOutputTokens` from the contract text are tolerated but not required. A row is only sent
    to `PUT /prices` once an admin has edited it, since every written row becomes `source:
admin`.
39. **Budget targets.** `GET /settings/scopes` answers for `template | campaign | tenant`; a
    `session` budget therefore still takes a typed id.

Phase 3 (`18-api-contract-phase3.md`):

28. **Owner sessions reuse the participant hook.** `src/lib/api/requirements-session.ts`
    adapts the staff routes (`GET /requirements/:id`, `path`, `turns`, `complete`) to the
    `ParticipantApi` shape, so `useInterview` drives the workspace unchanged. `pause`,
    `consent` and `setMode` are no-ops; `deleteData` and the summary routes reject with
    "not available". "I'm done" posts `complete` and then the `"I'm done"` text turn, as
    in the participant flow (gap 2). Reopen posts `reopen`, reloads the session and
    remounts the conversation.
29. **`event: spec`.** Parsed by `readTurnStream` as `{ type: "spec", spec }` and handed to
    the optional `onSpec` callback of `useInterview`. The live spec is tolerant: missing
    `mvpChallenge` / `stats` default to empty; findings get the shared defaults.
30. **Version routes take the version number** (`/versions/:v`), not the id; the version
    page is `/admin/requirements/[id]/versions/[v]`. Exports are plain links through the
    proxy (`/api/staff/requirements/:id/versions/:v/export?format=md|json|bundle`), so the
    API's `Content-Disposition` decides the file name. `document` and `bundle` are
    tolerated absent while a version is queued or running; the list and the version page
    poll every 3 s until `done` or `failed`. A `done` version with `error` set is shown
    with a fallback note (contract 18).
31. **GitHub push** sends `{ repository, token, branch?, directory?, message? }` with empty
    optional fields omitted; the token is cleared from the form after the call.
32. **Invitations.** `POST /requirements/:id/invitations` is expected to return the new
    `SessionInvitation` (bare or under `invitation`); revoke marks the row `revoked`
    locally. The public arrival `/p/r/[token]` calls `GET /p/r/:token` server-side and
    `POST /p/r/:token/open` through the participant proxy (its last segment is `open`, so
    the existing cookie rule applies), then `consent` with the `consentVersion` from the
    invite payload and, when `pathSelection` is `technical_or_not`, `setPath`.
33. **MVP challenge** is shown as not started / in progress / done with the number of
    items asked; the contract carries no total to show "n of m".
34. **`sourceKind`** labels are known for `text`, `handoff`, `invitation` and
    `attachment`; other kinds are shown without a label. `StaffSession.templateKey`
    (optional) enables the "Open requirements workspace" link on `/admin/sessions/[id]`.

Phase 4 (voice and files, `09-voice-and-files.md`):

35. **`session.capabilities`** carries `recordedVoice`, `fileUpload`, `maxSizeMb` and
    `allowedTypes` as they are in force. Every field is tolerated absent and defaults to what
    the app did before the API sent them (both features on, 20 MB, the eight shipped types),
    so an older API is never read as "everything off". The microphone, the voice mode and the
    paperclip are hidden when the flags say so, the picker's `accept` and the client-side
    refusals follow `allowedTypes`, and size is checked against `maxSizeMb` before uploading —
    a 413 is still handled, since the setting can change while the page is open.
36. **`session.attachments`** seeds the list on first render; the separate `GET
/p/session/attachments` is only used by the poll for pending files and by the re-read after
    a recorded turn, whose audio the server attaches on its own.
37. **Voice is participant-only.** `requirements-session.ts` rejects `sendVoice` and the
    attachment methods with "not available" and reports both capabilities as off: the staff
    requirements routes have no equivalent, and the owner workspace renders no controls.
38. **Transcript confidence** is parsed from `event: transcript` but not shown; the spec traces
    it in stats rather than in the interview. The live socket's `caption.confidence` is treated
    the same way.
39. **`capabilities.liveVoice` and `capabilities.captions`** default to `false` and `true`. Live
    voice is the one capability that defaults off, because an API that predates the socket has
    nothing to connect to and a call that cannot open is worse than a record button.
40. **With `voice.captions` off the participant's own words never reach this client.** The server
    sends captions only when the setting is on, and nothing else carries the transcribed answer
    to the browser, so the list shows only the interviewer's side for the length of the call. The
    messages are persisted either way and appear on the next load; the call panel says so rather
    than pretending the answers were lost.
41. **Opening a call sends `{type:"speak_last"}`, never `{type:"start"}`.** `start` runs an engine
    turn, and `useInterview` has already taken the opening turn over SSE by the time anyone picks
    voice, so it would ask the same question twice. `speak_last` reads the question already on
    screen, takes no turn, stores nothing and opens the interview when nothing has been asked yet,
    so it is sent unconditionally — including after a reconnect, where it re-reads the question
    the drop interrupted.
42. **Only one turn at a time.** The API refuses concurrent turns on a session, so typing, a
    widget answer, "skip", "come back", "I'm done", pause and delete all end the call first, and
    the recorded-voice microphone is hidden while a call is up.
43. **`unavailable.fallback: "text"` withdraws recorded voice too.** Recorded voice transcribes
    through the same route the live call just failed to find, so with no transcription route the
    microphone, the voice mode and the call panel all go away and the mode switches to chat. An
    unrecognized `fallback` value is treated as `text`, since typing is the only rung of the chain
    that cannot itself be the thing that is broken.
44. **Skip, "come back" and "I'm done" are controls (D-170).** They are sent as
    `{ control: { type: "skip_area" | "return_area", areaKey } | { type: "finish" } }` on
    `POST /p/session/turns` (and `/requirements/:id/turns`), never as text, so they cannot reach the
    transcript or the extractor. The stream opens with a `control` event: the progress chips move at
    once and the conversation shows a quiet system chip ("You skipped Tools and systems"), which is
    local to the screen and gone after a reload. Skipping is not asked about; it offers Undo for six
    seconds, and Undo sends `return_area`. "I'm done" still asks first (D-111). The deprecated
    `POST /p/session/complete` is no longer called.
45. **The answer-mode change is recorded as a `mode_switch` session event (D-171).** The web posts
    the existing `POST /p/session/mode`; the API writes the event when the mode really changes. The
    one thing the web adds is `reason: "fallback_typing"` when it moves to typing because nothing
    can transcribe.
46. **Suspending a tenant describes its effect.** The dialog says staff cannot sign in and
    participants cannot open links, which is what suspension is for; at the time of writing the
    API stores the status and does not yet enforce it (security M1). Ship the two together.
47. **The resume recap is `session.recap` on `GET /p/session` (D-172).** Two sentences, written by
    the API from state, shown as a labelled region above the conversation (focus lands on its
    heading) and on the paused screen. It is never added to `messages` and never announced as a
    message; Continue focuses the answer box and answering ends it. A client reading an older API
    sees no `recap` and no banner.
48. **A flagged interview is `flagged` on the sessions list and the session (D-173).** The table
    shows a "Needs attention" badge (icon and words), the toolbar filters on `flagged`, and the
    interview page opens with a callout whose one action, Acknowledge, posts
    `POST /sessions/:id/flag/ack`. `flagReason` is null unless the viewer may read transcripts, and
    the callout says so rather than showing nothing.
49. **`DELETE /p/session` answers `{ ok, emailSent }` (D-175).** The deleted screen names an email
    only when `emailSent` is true; the always-shown copy still promises answers, recordings and
    files only.

## Accessibility evidence

- `pnpm --filter @aidp/web contrast` computes every named colour pair of `globals.css` in the light
  and the dark theme (4.5:1 text, 3:1 edges). The web tests run it (`test/contrast.test.ts`), so a
  colour edit that drops below the bar fails there.
- `pnpm --filter @aidp/web e2e` runs Playwright with axe over every page in six projects (en and fi
  at 390 and 1280 px, reduced motion, dark). It needs a browser and a production build, so it is not
  part of `pnpm check`, which prints a notice saying so. One-time setup:
  `pnpm --filter @aidp/web exec playwright install chromium`. It starts `e2e/fake-api.ts`, a small
  stand-in for the API with fixtures for every page, and fails on serious or critical violations.
  A page added under `src/app` needs an entry in `e2e/pages.ts` (a unit test checks).
- Themes: System, Light, Dark, by `data-theme` on `<html>`; see D-238.
