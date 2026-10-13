# Design plan: participant and admin to 9.5/10 and WCAG 2.2 AA with evidence

Scope: `apps/web` (Next.js 16 App Router, Tailwind v4 tokens in `src/app/globals.css`, hand-written shadcn-style primitives in `src/components/ui`, en/fi strings in `src/i18n`). Baseline is the 2026-10-13 review (participant 7/10, admin 6.5/10). This plan does not redo the review; it turns its findings plus what I read in the components into a build spec. Nothing was modified.

Reading notes that shape the plan (all verified in code):

- The participant flow is already phone-first and resilient. Its remaining problems are small and surgical: `MessageList.tsx` nests an `aria-live` region inside `role="log"`; `ModeSwitch.tsx` fakes radios with buttons and no roving tabindex; `InterviewScreen.tsx` sends "Let's skip this for now (Area)" and "I'm done" through `sendText`, so they land in the transcript as participant speech; `Composer.tsx` sends on Enter unconditionally, so a phone keyboard has no newline; `useInterview.ts` maps a fetch failure to `network_error` but the screen shows the generic "Something went wrong"; `app/not-found.tsx` links to `/` which is the staff sign-in; `recapLabel` exists in `en.ts` and nothing renders it; the `requestCompletion` service hack (`turnCount = MAX_SAFE_INTEGER >> 1`) is why "I'm done" has to be faked as a message.
- The admin is coherent (PageHeader, Panel, StatTile, IconButton, Flash/useAction, Combobox are good) but every long form puts errors at the top with no focus move; the campaign page has no edit, no settings link and no hostility column; `ScopePicker` needs a submit button; `CategoryForm` loses edits on category change; 24 `humanize(` call sites and six raw enum renders leak identifiers; `AlertDialog` is used for archive template, delete budget and delete provider only.
- The design system is one light theme with seven raw hex values in `ui/*` and three brand gradients inlined in components. Control boundaries rely on `--shadow-control` (10% navy, about 1.3:1). Radix enter/exit animations from `tw-animate-css` are unguarded; only the typing indicator, skeleton and spinners are `motion-safe`.

---

## 1. Participant flow redesign spec

Global rules for every participant screen (apply once, in the shared pieces):

- Layout: `CenteredShell` card is `max-w-md`; at 390px the card has 16px side gutters (`px-4`), the gradient band stays, headings `text-2xl`. Desktop: card vertically centred. The interview itself (`InterviewScreen`) is full-bleed with a `max-w-2xl` column.
- Focus: on each step change inside `ArrivalFlow` and `InviteArrival`, move focus to the new `<h1>` (`tabIndex={-1}`, `ref.focus()`), so screen readers hear the new step and keyboard users do not start from the top. Today focus stays wherever the clicked button was, which has just unmounted.
- Live regions: one `role="status"` per screen for progress ("Sending code…"), `role="alert"` only for errors that block the current action. `Alert` gains a `role` prop (see 3).
- Reduced motion: a global reduce rule (3) covers Radix animations, `scrollIntoView({behavior:"smooth"})` in `MessageList` is replaced by `behavior: prefersReduced ? "auto" : "smooth"`.
- Language switch stays top-right on every pre-interview screen and in the interview header; it is a native `<select>` already, keep it.
- Every screen has exactly one primary action, full-width on phones (`w-full sm:w-auto`), 44px tall (`size="lg"`).

### 1.1 Arrival (`components/participant/ArrivalFlow.tsx`, step `arrival`; `app/p/[linkToken]/page.tsx`)

- Purpose: the person decides in ten seconds whether to start. Spec 06: company, two-sentence purpose, length, what is stored, how to delete, mode, one button, no account.
- Layout 390px: eyebrow, h1 (company sentence), purpose paragraph, three-row `<dl>` (length, stored, deletion), primary button, footnote. Desktop: same, in the centred card. Add a fourth `<dd>` only when the campaign has recorded or live voice enabled: "You can type, choose from options, or talk" so the mode promise of spec 06 is kept before the person commits.
- States: default; `busy` (button spinner, label "Loading…"); error (inline `Alert`, kept until next attempt); resume (when `grant.resume` is true the API already routes to `/p/session`; add a 400ms interstitial status "Picking up where you left off" with `role="status"` so the jump is explained).
- Microcopy direction: the h1 names the organization and says what they want to learn, not what the tool is. "What is stored" must name the two things that differ per mode (answers; email yes/no) and nothing else. The deletion line must say it is immediate and self-service. No product marketing above the button; `poweredBy` stays in the footnote.
- Accessibility: `<dl>` stays (it is read as pairs). Eyebrow is not a heading. The primary button text must not change meaning when busy ("Get started" to "Loading…" is fine).
- Component changes: `ArrivalFlow.tsx` adds `headingRef` focus-on-step; the voice line reads `campaign` capabilities (needs the public link response to carry `capabilities.recordedVoice|liveVoice`; today only `/p/session` carries them, see 6 for the API flag).

### 1.2 Verification: email and code (`ArrivalFlow.tsx`, steps `email`, `code`)

- Purpose: prove one person answers once, with the least friction.
- Layout: label, input, primary button, ghost "Back". Code step: six-digit input (`inputMode="numeric"`, `autoComplete="one-time-code"`, centred, letter-spaced), hint, Confirm, then two ghost actions in a row on desktop, stacked on 390px (today they are `flex justify-between` and collide at 390px with Finnish labels).
- States: idle; sending (button "Sending…"); sent (code step with a `role="status"` line "Code sent to x"); wrong code (inline error under the input, `aria-invalid`, `aria-describedby` to the error, focus moves to the input); domain not allowed (error explains the restriction and offers "Use a different email" as the primary recovery); resend cool-down (disable Resend for 30 s with a visible countdown in the button, `aria-live="off"`, and a `role="status"` "You can request a new code in 30 seconds" once); rate limited (429: "Too many attempts. Wait a minute and try again.").
- Microcopy direction: say why the code is needed in one sentence (uniqueness), and in anonymous campaigns say in the same sentence that the email is not stored with answers. The code screen names the email so a typo is visible. Error copy names the fix ("Check the digits or request a new code").
- Accessibility: errors are rendered inside the form, under the field, not as a detached `Alert`; the `Alert` stays for transport errors only. `pattern="[0-9]{6}"` is kept.
- Component changes: `ArrivalFlow.tsx` (field-level error state `fieldError`, resend cooldown, focus management). No API change.

### 1.3 Details and consent (`ArrivalFlow.tsx` steps `details`, `consent`; `InviteArrival.tsx` step `consent`)

- Purpose: the participation choice (identified/anonymous) and the consent text, then start.
- Layout 390px: the two participation choices are stacked `ChoiceTile`s (new primitive, 3.3) with radio, label, hint; required fields below; Continue. Consent: title, scrollable consent card (max-height 50dvh on phones with a visible scroll shadow), checkbox "I have read…" (today only `InviteArrival` has it; add it to `ArrivalFlow` too so both flows record explicit agreement), primary "Start the interview".
- States: missing required field (field-level error + focus to the field; today the error is a page-level `Alert` and focus does not move); consent not ticked (button disabled with a visible reason under it, not a silent disabled button); starting; error.
- Microcopy direction: the two choice hints state the one consequence each ("Admins can follow up with you" vs "Only aggregated results carry your answers"). The consent button says what happens next ("Start the interview"), not "Agree".
- Accessibility: `fieldset/legend` for the choice (exists); `RadioGroupItem` inside a `<label>` works but the hint uses `aria-describedby` on the item (exists). The consent card gets `tabIndex={0}` and `aria-label="Consent text"` so keyboard users can scroll it. A `details`-style "Read in full" is not needed; show all text.
- Component changes: `ArrivalFlow.tsx` (checkbox, field errors), `InviteArrival.tsx` (field errors), new `components/ui/choice-tile.tsx`.

### 1.4 Path choice (`PathChoice.tsx`)

- Already good. Changes: convert to `ChoiceTile` so selected/unselected states have a 3:1 boundary (today `border` at 1.2:1 and selection shown by `border-primary bg-accent`, which is fine, but the unselected boundary is not). In the one-shot variant (no `value`) announce "Starting…" via `role="status"` after a tap and disable both tiles.

### 1.5 Interview (`InterviewScreen.tsx`, `MessageList.tsx`, `Composer.tsx`, `ModeSwitch.tsx`, `ProgressAreas.tsx`, `AttachmentList.tsx`, `widgets/*`)

Purpose: a streaming conversation that feels like a capable assistant, answerable by chat, options, recorded voice, live voice or files.

Layout 390px: sticky header (brand, title, mode switch, language, menu) on one row; progress chips on a second row that scrolls horizontally; the message column; a sticky composer card with safe-area padding. Desktop: same column at `max-w-2xl`; the progress row can show all chips.

States (each is a visible state of the screen, named so tests can assert it):

| State               | What the participant sees                                                     | Live region                                                                                    |
| ------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `first-turn`        | Typing indicator only, composer disabled                                      | `role="status"`: "The interviewer is writing"                                                  |
| `streaming`         | Interviewer bubble grows; composer disabled                                   | none while streaming; final text announced once (below)                                        |
| `awaiting-answer`   | Last bubble complete, widget if any, composer enabled and focused (chat mode) | one announcement of the final message plus "Question with 4 options" when a widget is attached |
| `sending`           | Participant bubble appears optimistically, indicator                          | status: "Sending" (exists as string `sending`)                                                 |
| `recording`         | Red bar with timer, Discard and Stop                                          | existing announcements                                                                         |
| `uploading`         | Attachment row "Sending your file…"                                           | status                                                                                         |
| `attachment-failed` | Row with reason, Remove                                                       | alert                                                                                          |
| `error-retryable`   | Alert with Retry and Close; the unsent answer is kept in the composer         | alert                                                                                          |
| `offline`           | Alert: offline sentence, Retry disabled until `online`                        | alert, then status "Back online, sending…"                                                     |
| `budget-paused`     | Warning alert, composer hidden                                                | alert                                                                                          |
| `ended`             | SummaryView, footer "This interview is complete", composer hidden             | status                                                                                         |

Microcopy direction: the interviewer's words are the model's; everything else on the screen is quiet, lower-case-feeling chrome. Status lines say what the system is doing in the present tense ("Sending your recording…"). The error alert always has three parts (what happened, what to do, what we kept), see 4.

Accessibility behaviour and the fixes:

1. Streaming double-announcement (`MessageList.tsx`). Today: the list is `role="log"` (implicitly `aria-live="polite"`) and the streaming bubble sits in a nested `aria-live="polite"` div, so every token delta is announced and then the completed message is announced again when `turn` replaces it. Redesign: the list becomes a plain `<ol aria-label="Conversation">` (no `role="log"`); the streaming bubble is rendered in a container with `aria-live="off"` (visual only); one visually hidden `<p role="status" aria-atomic="true">` ("the announcer") is set to the final interviewer text exactly once, in the `turn` branch of `useInterview` (expose `lastAnnouncement` in `InterviewState`), suffixed with the widget summary ("Question with 4 options", "Scale from 1 to 5", "Yes or no") built from `widget.type`. The participant's own bubbles are never announced (they typed them). The `TypingIndicator` keeps `role="status"` with the label; it is removed from the DOM when streaming begins so "is writing" is heard once.
2. `ModeSwitch.tsx`: replace the `role="radio"` buttons with Radix `ToggleGroup` (`type="single"`, `rovingFocus`, `loop`) from the `radix-ui` umbrella already installed. Each item gets `aria-label={label}` so the icon-only phone variant has a name without `title`. Selection also writes a `mode_switch` session event (API, see 6) so the admin transcript can show the change. Minimum item size 32×32 (admin) / 36×36 here; the group has `aria-label="Answer mode"`.
3. Skip and done leaking into the transcript. Engine-side state operation (the real fix) plus UI:
   - Contract: `POST /p/session/turns` body gains `control?: { type: "skip_area", areaKey } | { type: "return_area", areaKey } | { type: "finish" }`, mutually exclusive with `content`/`widgetResponse` (`TurnBody` in `apps/api/src/modules/participant/routes.ts`). `UserAnswer` in `packages/ai/src/engine/engine.ts` gains `control?`.
   - Engine (`engine.ts`, `state.ts`, `selection.ts`, `context.ts`): when `answer.control` is present no user message is appended. `skip_area` sets `coverage[areaKey].status = "skipped"` and appends `SessionEvent` type `control` `{ kind, areaKey }`. `return_area` sets `coverage[areaKey].status = "partial"` when it was `skipped` (an engine op may lower status; `applyDelta`'s rank guard applies only to model deltas) and sets a new `SessionState.requestedAreaKey` that `chooseFocus` consumes once (`{ mode: "continue", areaKey }`) and clears. `finish` sets a new `SessionState.completionRequested = true`; `chooseFocus` returns `{ mode: "closing" }` when it is set. This replaces the `turnCount = MAX_SAFE_INTEGER >> 1` hack in `participant/service.ts#requestCompletion`, which also corrupts the turn count used in stats. `context.ts` renders one line for the model: "The participant chose to skip <area>. Acknowledge it in one sentence and move on." / "The participant asked to end. Ask the closing question." The model never sees a fabricated participant utterance.
   - Transport: the SSE stream emits a `control` event echo `{ kind, areaKey, at }` before the interviewer `turn`; the admin transcript shows it as a system chip.
   - UI: `useInterview` gains `sendControl(control)`; `InterviewScreen.skip/back/done` call it. `MessageList` renders control echoes as a centred, muted system chip (`<li>` with text "You skipped Tools and systems", `aria-label` same) rather than a participant bubble. `ProgressAreas` popover: after "Skip this for now" an undo toast for 6 s ("Skipped Tools and systems. Undo") which sends `return_area`.
   - "I'm done" gets an `AlertDialog` (spec 19 asks for it; today it fires immediately): title "Finish the interview?", body "The interviewer asks one closing question, then shows you a summary you can edit. You can still delete your data afterwards.", actions Cancel / Finish.
   - Spec: new decision row D-81 in `docs/discovery/decisions.md`; contract 16 patch; `FR-12` test ids in commits.
4. Composer newline on mobile (`Composer.tsx`). Today Enter always submits (`enterKeyHint="send"`), so a phone keyboard cannot insert a newline. Rule: on coarse pointers (`matchMedia("(pointer: coarse)")`, evaluated once in a `useCoarsePointer` hook) Enter inserts a newline and only the Send button sends, with `enterKeyHint="enter"`; on fine pointers Enter sends and Shift+Enter inserts a newline, with a one-time hint under the textarea for keyboard users ("Enter sends, Shift+Enter for a new line") shown on first focus and dismissible, also in the textarea's `aria-describedby`. The textarea grows to `max-h-40` (exists) and keeps its text on any send failure (`useInterview` already keeps the optimistic message; the composer must not clear `text` until the `turn` echo arrives, so change `submit()` to clear on `onSend` resolve rather than immediately).
5. Offline sentence. `useInterview` already yields `code: "network_error"`. `InterviewScreen` maps it to a dedicated `offline` state: title "You seem to be offline", body "Your last answer was not sent. It is kept here, and we will try again when you are back online.", Retry button disabled while `navigator.onLine === false`, auto-retry on the `online` event once, with a status "Back online, sending…". Add `useOnline()` hook. Also show a thin persistent bar under the header while offline (`role="status"`, not `alert`, because the alert already fired).
6. Keyboard map (documented in the screen's `aria-keyshortcuts` on the composer): Enter/Shift+Enter as above; `Esc` closes popovers (Radix); in a widget the arrow keys move within the group (scale exists; single choice via Radix radio; ranking via buttons). No global single-key shortcuts (WCAG 2.1.4).
7. Widgets (`widgets/*`): option rows become `ChoiceTile` (3:1 boundary, `has-[:checked]` ring). `MultiChoiceWidget` shows "Choose up to N" as the fieldset description (`widgetMaxHint` exists). `ScaleWidget` keeps the roving tabindex; add `aria-describedby` to the min/max labels. `RankingWidget`: announcement exists; add "Done ordering" hint that the Send button submits the current order. `OtherInput` accepts speech: when `onVoice` is available show the mic icon button inside the Other field (spec 06: "Other accepts typing or speech"); it reuses `useRecorder` and fills the field with the transcript (needs the transcription route; reuse `POST /p/session/turns/voice` with `dryRun=true`? No: add `POST /p/session/transcribe` returning text only, flagged in 6).
8. Attachments (`AttachmentList.tsx`): rows use `Inset` (3.3) instead of `border`; status line stays; a failed row's reason is the API `error` string mapped through the error rules (4). Remove gets an undo toast (6 s) instead of immediate deletion; the row is greyed with "Removed. Undo" until the toast expires, then the DELETE is sent.
9. Header title: the `h1` is "Interview" by default; use the campaign name when the session carries it so the tab and the heading say where the person is.

Component changes (files): `components/participant/MessageList.tsx` (announcer, system chips, reduced-motion scroll), `ModeSwitch.tsx` (ToggleGroup), `Composer.tsx` (coarse-pointer rule, deferred clear, hint), `InterviewScreen.tsx` (controls, offline state, done dialog, header title), `ProgressAreas.tsx` (control emit, undo toast), `AttachmentList.tsx` (Inset, undo), `widgets/*` (ChoiceTile, Other mic), `hooks/useInterview.ts` (`sendControl`, `lastAnnouncement`, control echo), `hooks/useOnline.ts`, `hooks/useCoarsePointer.ts` (new), `lib/api/participant.ts` (`sendControl`, transcribe), `lib/api/sse.ts` (control event), `i18n/en.ts|fi.ts` (offline, done dialog, chips, hints).

### 1.6 Live voice full-screen mode (spec 06; `LiveVoiceCall.tsx` today is a composer panel)

- Purpose: a call, not a form. Captions of both sides, interruptible, widgets read aloud in short form, fall back without losing the session.
- Design: a new `LiveVoiceScreen.tsx` rendered as a Radix `Dialog` (focus trap, `aria-modal`, Escape handling) that covers the viewport when `live.status` is `connecting|listening|thinking|speaking`. Layout 390px, top to bottom: a small header (campaign name, elapsed time `role="timer"`, End call button top-right, 44px); a caption area that is the conversation itself: the interviewer's current sentence in large type (`text-xl`, from the streamed `turn` text or the TTS caption) and the participant's partial in italic below (`aria-live="off"`, as today); a status word row ("Listening", "Thinking", "The interviewer is speaking") with the decorative level meter; the bottom bar: "Stop the interviewer" (visible only while speaking), "Type instead" (ends the call, focuses the composer), "End the call". Desktop: same, centred at `max-w-2xl`, captions larger. The full transcript stays visible behind by scrolling the caption area; "Show conversation" toggles the message list inside the dialog.
- Widgets in a call: read aloud in short form (D-71 exists server-side); on screen the options render as tappable `ChoiceTile`s under the caption so a tap answers without speaking; speaking "the second one" is left to the engine.
- States: connecting (status + indeterminate text; no spinner animation under reduced motion), listening, thinking, speaking, not heard (status "We did not catch that"), text-only voice (the interviewer's answers appear as captions, call continues: string exists `liveTextOnly`), lost (alert + two buttons: "Reconnect", "Type instead"), gave-up recorded (`liveUnavailable`), gave-up text (`liveTypeOnly`).
- Accessibility: `role="status"` for the phase (exists); the caption of the interviewer is announced once when the sentence completes (same announcer as the message list; the dialog gets its own instance). Barge-in from the keyboard: Space while focus is on the dialog content stops the interviewer (documented via `aria-keyshortcuts="Space"` on the Stop button). No auto-scrolling text under reduced motion; show the full caption instead of word-by-word. Focus: on open to "End the call" (exists), on close back to the mode switch, not the composer, because the mode switch is what changed.
- Microcopy direction: the status word is the message; hints are one sentence and disappear after the first utterance. Fallbacks say what still works, never what failed internally.
- Component changes: new `components/participant/LiveVoiceScreen.tsx`; `LiveVoiceCall.tsx` shrinks to the idle "Start a voice call" card; `InterviewScreen.tsx` mounts the screen on `inCall`; `useLiveVoice.ts` exposes `elapsedMs` and the current interviewer caption (`speakingText`) if not already carried by `onTurn`.

### 1.7 Resume with a two-sentence recap (spec 06; strings `recapLabel`, `resume` exist unused)

- Purpose: reopening the link says where the person was so they can continue without scrolling.
- API: `GET /p/session` returns `recap?: string` when `messages.length > 0` and the session was paused or idle for more than 10 minutes. The service generates it with purpose `resume_summary` (exists, used by the rolling summary) from `session.summary` plus the last interviewer message and the covered areas, with a new versioned prompt `packages/ai/src/engine/prompts/recap.v1.ts` ("two sentences, second person, what was covered and what comes next, no questions"), cached in `state.recap = { text, upToSeq }` and regenerated only when `summaryUpToSeq` advanced. Fallback without a model call: a deterministic sentence from progress ("You covered 3 of 7 areas. Next: Tools and systems."), which is also what the evals replay.
- UI: `RecapBanner` above the message list: label "Where you left off", two sentences, button "Continue" that focuses the composer (or the widget), and "Jump to the latest message". It is a `region` with `aria-labelledby`; focus lands on its heading when the page opens as a resume. Not shown when the session is brand new or complete.
- The paused `StatusScreen` ("Interview paused") gets the same recap text under its body so pausing and reopening read the same.
- Files: `components/participant/RecapBanner.tsx` (new), `InterviewScreen.tsx`, `lib/api/schemas.ts` (`recap`), API `participant/service.ts#getSession`, `packages/ai/src/engine/prompts/recap.v1.ts`, evals fixture.

### 1.8 Pause (`InterviewScreen.tsx` `paused` screen, `SessionMenu.tsx`)

- No confirmation (reversible). The paused screen says the answers are saved, shows the recap, and has "Resume now". Add "Delete my data" as a ghost link here too (spec: one tap away). Focus moves to the h1 on entering the screen.

### 1.9 Ending and summary (`SummaryView.tsx`)

- Purpose: closing question (engine), then an editable summary, a thank-you, what happens next; nothing about opportunities.
- Layout: the summary is a `Card` (not `rounded-2xl border`) with h2 "Thank you", the body sentence, a textarea with its label, "What we noted" list, Save with an inline saved status (exists), "What happens next", close line, Delete my data.
- States: loading (skeleton + sr text, exists); summary available; summary unavailable yet (the API answers before the extraction job finished): show "Your summary is being prepared" with a poll every 3 s up to 30 s, then "We will keep your answers; the summary could not be prepared right now" — today it silently renders nothing when `getSummary` fails. Saved; save failed (inline alert).
- Microcopy direction: the thank-you is one line, no exclamation mark. "What happens next" must say aggregation and that nothing is attributed without consent (exists). Delete stays a ghost destructive button and opens the same AlertDialog as the menu (today `onDelete` on the summary skips the dialog).
- Accessibility: the textarea has a visible label; the facts list is a `<ul>`; the saved indicator is `role="status"`.

### 1.10 Delete my data (`SessionMenu.tsx`, `InterviewScreen.tsx` `deleted` screen)

- AlertDialog exists; keep the wording rule: title asks, body states scope and irreversibility, confirm button repeats the verb. The deleted screen must not promise an email unless the participant was identified: the `deleteData` response should return `{ ok, emailSent: boolean }` and the body picks the sentence; today it says "If you were identified, a confirmation email is on its way" while the review found no email is sent, so the sentence is removed until the API sends it (status review tier 4). The screen has no actions; the cookie is cleared by the proxy; the language switch stays.

### 1.11 Expired, closed, invalid, revoked, completed (`StatusScreen.tsx`, `app/p/[linkToken]/page.tsx`, `app/p/r/[token]/page.tsx`, `app/p/session/page.tsx`)

- `StatusScreen` is right. Add: focus to h1 on mount (client wrapper or `autoFocus` on an `h1 tabIndex=-1`), an optional `action` slot that every page fills with one recovery ("Open the link from your invitation email again" is text, not a button, because there is nothing to click), the language switch (`aside`) so a Finnish participant can read the message, and `tone` icons stay decorative.
- Server locale: these pages read `t.*` without awaiting the request locale (review item 7). Each `app/p/**/page.tsx` awaits `getStrings()` and uses that object, not the module-level `t`.

### 1.12 Error and offline states (`app/p/error.tsx`, `app/error.tsx`)

- `p/error.tsx` shows "The interviewer is temporarily unavailable" for any thrown error, including a 500 from the page itself. Make it: title "Something went wrong on our side", body "Nothing you said is lost. Try again; if it keeps happening, reopen your link in a few minutes.", Retry, and a reference id (`error.digest`) in small text for support. Offline inside the interview is 1.5 item 5; offline on arrival (fetch failed server-side) renders the same error page.

### 1.13 404 for participants (`app/not-found.tsx`, new `app/p/not-found.tsx`)

- Today a participant who mistypes a link sees "404" and a "Back" button to `/`, which is the staff sign-in. New `app/p/not-found.tsx` renders `StatusScreen` with `invalidTitle/invalidBody` and no link. The root `not-found.tsx` becomes: title "This page does not exist", body with two sentences: "If you were invited to an interview, open the link from your invitation email." and, only when a staff session cookie exists (server component can call `auth()`), a "Go to the dashboard" button; otherwise no button. The page is server-rendered with the request locale.

---

## 2. Admin redesign spec

Admin-wide rules: every list page keeps `ListToolbar` + `Pagination` (four pages still lack the toolbar: campaign sessions, budgets, provider prices twice). Every long form uses the validation pattern in 2.3. Every destructive or participant-affecting action follows the confirmation table in 2.9. Every enum goes through `t.enums` (4.4). Server pages await `getStrings()`.

### 2.1 First-run onboarding (`app/admin/page.tsx`, new `components/admin/SetupChecklist.tsx`)

- Trigger: the tenant has zero campaigns and zero requirements sessions (`campaigns.total === 0 && requirements.total === 0`). The dashboard then renders the checklist above the stat tiles (which show dashes) rather than an empty chart grid. A platform operator acting on a tenant sees it too.
- Eight steps, each a row with number, title, one-sentence why, state (done / next / later) and one CTA. State is derived from existing endpoints in one `Promise.allSettled`: `providers.list` (step 1 done when an enabled provider with a key or a platform provider exists), `routes.get` (step 1b: `interview` purpose routed, tenant or platform), `templates.page({status:"published"})` (step 2), `campaigns.list` (3), campaign `link` (4), `campaigns.sessions` completed > 0 (5), `analyses.list` done (6), report fetched (7), `requirements.list` (8).
  1. Connect a model provider → `/admin/providers` (or "Use the platform provider" when one exists: done).
  2. Pick a template → `/admin/templates` (copy a shipped one, publish).
  3. Create a campaign → `/admin/campaigns/new?templateId=…` (prefilled).
  4. Share the link or invite people → campaign page, Invitations tab.
  5. Watch results come in → campaign page, Sessions tab (shows "0 of n started").
  6. Run the analysis → results page (enabled when completed ≥ threshold, with the threshold shown).
  7. Read the report → report page.
  8. Promote an opportunity to requirements → results page.
- Dismissal: "Hide this checklist" writes tenant setting `ui.onboardingDismissed: true` (new catalog key, category `other`, tenant scope, no code reads it except the web). It reappears from a "Setup guide" link in the sidebar footer.
- Microcopy direction: each step says the outcome ("People can open the link on their phone, no account needed"), not the feature. The one with budget: step 1 also mentions "Set a monthly budget so a campaign cannot overspend" as an optional sub-line linking to `/admin/budgets`.
- Accessibility: an `<ol>` with `aria-label="Setup"`; each step's state is text ("Done", "Next", "Later"), the check icon is decorative; the "Next" step's CTA is the only `variant="default"` button on the page.
- Files: `app/admin/page.tsx`, `components/admin/SetupChecklist.tsx`, `packages/shared/src/settings.ts` (`ui.onboardingDismissed`), `i18n`.

### 2.2 Campaign lifecycle page (`app/admin/campaigns/[id]/page.tsx` + new `components/admin/campaigns/*`)

Today: a header with Results/Report buttons, a link box, open/close, three tiles, invitations card, sessions card. No edit, no settings, no analysis status, no export, no hostility flag.

Redesign as one page with URL-addressed tabs (`?tab=`, server-rendered like settings categories): Overview, Invitations, Sessions, Settings, Analysis. Results and Report stay their own routes (they are workspaces) and are linked from Analysis and the header.

- Header: name, `StatusBadge`, subtitle "template name · verification", actions: Edit (pencil, opens `CampaignForm` in edit mode on `/admin/campaigns/[id]/edit`, using the existing `PATCH /campaigns/:id`), Open/Close (close gets an AlertDialog because it stops participants mid-interview), Results, Report.
- Overview tab: link box with Copy (exists; make Copy a `Button` whose label flips and announce via a `role="status"` sibling, not `aria-live` on the button), QR code (client-side SVG, no dependency beyond a tiny generator; useful for posters), three tiles plus "Completed vs threshold" (`stats.completed / completionThreshold` with a `BudgetBar`-style meter), drop-off by area (translate area keys through the campaign's template areas, not `humanize`), analysis status card (latest version, state, "Analyze now" when threshold met, "x more completions needed" otherwise), spend for this campaign against its budget (from `/spend?campaignId`).
- Invitations tab: the `InvitationsPanel`; the upload label becomes a real `Button asChild`-less file input trigger (today a `span` styled as a button inside a `Label`, not keyboard-focusable); sending to more than 50 addresses asks an AlertDialog with the count; Revoke gets an AlertDialog (spec 19); Remind is an undo-less toast (not destructive); an empty state that says what an invitation does.
- Sessions tab: `SessionsTable` with `ListToolbar` (search, status filter, sort), new columns: Participant (name/email when identified, else "Anonymous · id prefix"), Mode (last modality), Flag (a `Badge variant="warning"` "Needs attention" when `flaggedForAdmin` is set, with the reason in a tooltip and on the session page), Progress meter (exists), Cost, Last activity. API: the sessions list rows need `flagged: boolean` and `lastModality`; the session detail needs `flaggedForAdmin` (flag in 6).
- Settings tab: the campaign-scope `CategoryForm`s embedded (`scope=campaign&scopeId=id`), showing inherited values and sources, with a note "These apply to this campaign only. Tenant settings are under Settings." This fixes "settings undiscoverable from their objects". The same embed goes on the template detail page for template scope.
- Analysis tab: analyses list (versions, status, preliminary, created, "Open results", "Open report"), Analyze now, and Export: Markdown (exists), PDF (new endpoint, Kroki), sessions CSV (new endpoint `GET /campaigns/:id/sessions.csv` respecting the transcript visibility setting). Exports are `Button asChild` links to `/api/staff/...` URLs so the browser downloads.
- Files: `app/admin/campaigns/[id]/page.tsx`, new `app/admin/campaigns/[id]/edit/page.tsx`, `components/admin/campaigns/{CampaignForm,CampaignActions,InvitationsPanel,SessionsTable,CampaignTabs,AnalysisPanel,QrCode}.tsx`, `lib/api/schemas.ts`, `lib/api/lists.ts` (sessions list already defined in contract 19).

### 2.3 Template editor (`components/admin/templates/TemplateForm.tsx`, `ListEditor.tsx`, `app/admin/templates/[id]/{page,edit}/page.tsx`)

- Section navigation: a sticky left rail (desktop) / top chip row (phone) listing the nine `FormSection`s (Basics, Participant fields, Path, Context block, Coverage areas, AI instructions, Adaptivity, Widgets, Issue detection, Outputs, Chaining, Closing) with anchor links and an error count badge per section after a failed submit. Sections become `<section id>` with `aria-labelledby` (they already have ids derived from the title; use stable keys instead of localized titles).
- Inline validation with focus management: on submit, zod issues map to field ids as today; add (a) an error summary `Alert role="alert"` at the top with one link per error ("Coverage area 2: key is required") that focuses the field on click, (b) focus moves to the summary heading, (c) each field has `aria-invalid` and `aria-describedby` (exists via `Field`), (d) the submit button shows "Fix 3 problems to save" as a status line beneath it, so it never "does nothing". Validate a section on blur-out of the section (soft) and the whole form on submit (hard). `ListEditor` items use `Inset` with a header row (item label, move up/down, remove) and expand/collapse; collapsed items with errors auto-expand on submit.
- Preview: exists (`/api/preview/:id` opens a throwaway session in a new tab). Add "Preview as participant on a phone" that opens the same URL in a 390×844 popup; mark the preview session in the participant header with a "Preview" badge (needs the session response to carry `preview: true`; flag).
- Version history and rollback: on the template detail page a Versions panel listing every version of this `key` (`templates.page({ q: key, limit: 200 })`, one row per version per contract 19), with status, created, "Diff against this version" (reuse `TemplateDiff` with two bodies; today it diffs only against shipped) and "Restore": creates a new draft version from the selected body. Cleanest as `POST /templates/:id/restore` (audit-logged `template.restore`); a client-side fallback is `templates.update(currentId, oldBody)` which also writes a new version. Rollback is confirmed with an AlertDialog that names the version numbers.
- Dirty guard: the editor registers with `DirtyContext` (2.7) so leaving with unsaved edits asks.
- Files: `TemplateForm.tsx` (summary, focus, section rail), `ListEditor.tsx`, `TemplateDiff.tsx` (two-body mode), new `components/admin/templates/VersionsPanel.tsx`, `app/admin/templates/[id]/page.tsx`, `components/admin/forms.tsx` (`FormSection` stable ids, `ErrorSummary`).

### 2.4 Results workspace (`components/admin/results/*`, `app/admin/campaigns/[id]/results/page.tsx`)

Already good at ranking, filters, overrides, promote, compare. Add:

- Cluster merge, split, rename (spec 04 admin actions): a selection mode (checkbox per card, "Merge 2 selected" in a sticky action bar) → AlertDialog that shows the two titles and asks for the merged title (default: the higher-ranked one). Split: in the card details, evidence quotes get checkboxes and "Split selected into a new opportunity". Rename is the override title (exists) surfaced as an inline pencil on the card heading. API: `POST /analyses/:id/opportunities/merge { ids, title }`, `POST /opportunities/:id/split { evidenceIds, title }`; both write `admin_override` records so they survive re-runs (flag in 6). Until the API lands, the UI ships with merge/split hidden behind the capability check `detail.capabilities.merge`.
- Department comparison respecting k: a "By department" panel (right column, under Weights) that calls `GET /analyses/:id/departments` and renders a `BarList` per opportunity class only for departments with ≥ k participants; departments below k are summarised as "n departments hidden because fewer than k people answered" (k from `analysis.k` effective setting). Flag API.
- "AI is not the answer" section: the `none` class group becomes a named section at the end: heading "Where AI is not the answer", intro sentence, each card shows `whyNotAi` first; the dashboard `DiscoveryTiles` adds a tile "Not AI" from `byClass.none` with the `not_ai` report section link.
- Overrides: `OverrideSheet` factor rows use `Inset`; the native `<select>` for scores becomes the `Select` primitive with the generated value as the first item (exists in spirit); add "Reset" per factor. The sheet registers with the dirty guard.
- Status changes (shortlist/dismiss/restore) get undo toasts (2.9), not confirmations.
- Files: `ResultsView.tsx`, `OpportunityCard.tsx`, new `MergeBar.tsx`, `DepartmentsPanel.tsx`, `OverrideSheet.tsx`, `components/admin/DiscoveryTiles.tsx`, `lib/api/staff.ts`.

### 2.5 Requirements workspace (`components/admin/requirements/*`)

- Live spec: `SpecSections` section keys through `t.enums.specSection` (today `humanize(key)`); each `SpecSectionCard` has Edit (exists) with the dirty guard.
- Findings: `FindingsList` boxes use `Inset`; the finding type and confidence through `t.enums`; settle actions (Resolve / Accept as is / Defer) are undo-toast actions, not confirmations.
- MVP challenge: a progress strip in the Findings tab from `state.mvpChallenge` (asked / remaining) with "Mandatory for this template" when the policy says so; needs `mvpChallenge` in `RequirementsDetail` (it is in session state; expose it; flag).
- Versions and diff: exist. Add "Compare" selector on the version page (exists as `VersionDiff`), label every file in the bundle list with its purpose in one line.
- Exports: downloads exist (`specExportUrl`); add PDF (`GET /requirements/:id/versions/:v/export.pdf`, Kroki-rendered diagrams; flag) and show the four export buttons in one `Panel` "Exports" with format descriptions (what Claude Code vs Codex vs generic contain).
- GitHub push: dialog exists; the token field says it is used once (exists). Add the result state's link to the commit (exists) and an undo-less toast.
- Invitations: `InvitationsSection` revoke gets an AlertDialog.
- Files: `SpecSections.tsx`, `FindingsList.tsx`, `VersionView.tsx`, `InvitationsSection.tsx`, new `MvpProgress.tsx`, `ExportsPanel.tsx`.

### 2.6 Settings (`app/admin/settings/page.tsx`, `components/admin/settings/*`)

- Scope picker navigates on change: remove the Open button. The scope `Select` navigates immediately (`router.push`) for scopes without a target; for template/campaign, the `Combobox` navigates when a target is chosen. Both are announced by the page title change and a `role="status"` "Showing settings for <target>". When a scope needs a target and none is chosen yet, the form area shows an inline instruction instead of the tenant's values (today it silently shows tenant values with `scope=campaign`).
- Dirty guard: new `components/common/DirtyGuard.tsx` providing `useDirty(id, isDirty)`; `CategoryForm` registers when `edits|resets|secretEdits|secretCleared` is non-empty; the category nav links and the scope picker consult the context and open an AlertDialog ("Leave without saving? Your changes to Engine will be lost." Stay / Leave) before `router.push`; `beforeunload` covers hard navigation. Same context reused by TemplateForm, CampaignForm, OverrideSheet, RequirementsForm.
- "What changed since your last visit": `SettingDef.since: string` (ISO date of the release that added or changed the key, e.g. `"2026-10-01"`) in `packages/shared/src/settings.ts`, surfaced by `GET /settings` catalog entries. The web stores `settingsLastVisit` per user in `localStorage` (per-viewer convenience, with a 60-day default when absent) and renders a collapsible panel above the categories: "New or changed since <date>: 4 settings" with key, category link and the description; each row has "Mark as seen". A `NEW` badge appears next to the category and the field. Flag the shared/API change in 6.
- Search across keys: a search input above the category nav filtering the catalog client-side on key, label and description across all categories; results list "Category › Label" rows that navigate to the category with `#setting-<key>` and a 2 s highlight (`:target` style). `Cmd/Ctrl+K` opens it; the field is a `role="searchbox"` with `aria-controls` the results list.
- Labels: every key gets `t.admin.settings.keys[key] = { label, description }` in en and fi; a unit test asserts coverage against `Object.keys(SETTINGS)` so a new knob cannot ship unlabelled. The `CategoryForm` secret, enum and weights labels drop `humanize`.
- Files: `ScopePicker.tsx`, `SettingsCategories.tsx`, `CategoryForm.tsx`, new `SettingsSearch.tsx`, `WhatChangedPanel.tsx`, `components/common/DirtyGuard.tsx`, `packages/shared/src/settings.ts`.

### 2.7 Providers, routes, budgets (`components/admin/providers/*`)

- Translated labels: provider `kind` badge, purpose names in `RoutesForm`, effort values, budget scope and period, route source, price source all through `t.enums`.
- Test connection: keep the inline result cell (D-78: failures stay next to their row) and add `toast.success("Connected to <provider> · <model> · 420 ms")` on success; on failure `toast.error` is not used; the cell shows the error text with a "Details" popover. While running, the cell is `role="status"` "Testing…".
- Budget bars: each budget row gets the dashboard `BudgetBar` (extract to `components/admin/BudgetBar.tsx`), `role="progressbar"` with `aria-valuetext="€120 of €500, 24%"`; colour thresholds 80/100 (exist) plus the text, never colour alone. The dashboard budget tile links to `/admin/budgets`.
- Budget delete keeps its AlertDialog; "Clear route override" becomes an undo toast (restores the previous draft on undo, re-PUTs).
- Routes table at 390px: today a seven-column table scrolls. Render as a card list per purpose on `<md` (purpose as card title, fields stacked), table on desktop.
- Provider form: `baseUrl` field gets a hint about https and reachable hosts (the SSRF fix is API work, but the field should say "Public https URL").

### 2.8 Operator pages (`app/admin/operator/*`, `components/admin/operator/TenantsPanel.tsx`)

- Tenants: Suspend gets an AlertDialog naming the tenant and the effect ("Staff cannot sign in and participants cannot open links until you activate it again"); Activate is immediate with a toast. The create form moves into a "New tenant" dialog so the table is first.
- Jobs: new `app/admin/operator/jobs/page.tsx`: queue depth per queue, failed and dead-lettered jobs with name, tenant, attempts, last error (truncated with a popover), "Retry" (AlertDialog when retrying more than one), "Discard". API: `GET /operator/jobs?state=failed|completed|active`, `POST /operator/jobs/:id/retry`, `POST /operator/jobs/:id/discard` over pg-boss (NFR-09; flag).
- Platform stats: `StatsGroups` labels through `t.enums.statGroup` and `t.enums.statKey`; unknown keys fall back to the key in monospace (an operator page may show raw keys, labelled as such) rather than `humanize`.

### 2.9 Confirmation policy

Rule: AlertDialog when the action affects another person, destroys data, or cannot be undone within the same screen; undo toast when it is reversible in one click and the cost of a mistake is low; neither when the action is the obvious result of what the person just typed or the state is trivially reversible.

| Action                                           | Policy                                      | Reason                               |
| ------------------------------------------------ | ------------------------------------------- | ------------------------------------ |
| Participant: Delete my data                      | AlertDialog (exists)                        | irreversible                         |
| Participant: I'm done                            | AlertDialog (new)                           | ends the interview for them; spec 19 |
| Participant: Pause                               | neither                                     | reversible by reopening              |
| Participant: Skip area                           | undo toast (6 s)                            | reversible via `return_area`         |
| Participant: Come back to area                   | neither                                     |                                      |
| Participant: Remove attachment                   | undo toast (6 s, deferred DELETE)           | low cost                             |
| Participant: Discard recording                   | neither (explicit button)                   | the person is still in the act       |
| Participant: End live call                       | neither                                     | session is kept                      |
| Participant: Mode switch                         | neither                                     |                                      |
| Admin: Close campaign                            | AlertDialog (new)                           | stops participants mid-interview     |
| Admin: Open campaign                             | neither                                     |                                      |
| Admin: Revoke invitation                         | AlertDialog (new)                           | affects another person               |
| Admin: Remind                                    | neither, toast                              |                                      |
| Admin: Send invitations (> 50)                   | AlertDialog with count                      | mass email                           |
| Admin: Send invitations (≤ 50)                   | neither, toast with count                   | count already in the button          |
| Admin: Delete campaign (if added)                | AlertDialog, typed name                     |                                      |
| Admin: Archive template                          | AlertDialog (exists)                        |                                      |
| Admin: Publish template                          | neither, toast                              | reversible by a new version          |
| Admin: Restore template version                  | AlertDialog                                 | creates a version others may pin     |
| Admin: Discard unsaved form                      | AlertDialog via DirtyGuard                  | data loss                            |
| Admin: Save settings category                    | neither, toast                              |                                      |
| Admin: Reset a setting to inherited              | undo toast                                  |                                      |
| Admin: Analyze now                               | neither (409 handled inline)                |                                      |
| Admin: Shortlist / dismiss / restore opportunity | undo toast                                  |                                      |
| Admin: Merge / split clusters                    | AlertDialog                                 | hard to reverse                      |
| Admin: Override opportunity                      | neither (sheet has Save)                    |                                      |
| Admin: Promote to requirements                   | Dialog (exists)                             | creates a session                    |
| Admin: Settle finding                            | undo toast                                  |                                      |
| Admin: Reopen requirements session               | neither, toast                              | creates a version by design          |
| Admin: Generate spec version                     | neither                                     |                                      |
| Admin: Push to GitHub                            | its own dialog                              | token entry is the confirmation      |
| Admin: Revoke requirements invitation            | AlertDialog                                 | affects another person               |
| Admin: Delete budget                             | AlertDialog (exists)                        |                                      |
| Admin: Clear route override                      | undo toast                                  |                                      |
| Admin: Save routes                               | neither, toast                              |                                      |
| Admin: Test connection                           | neither                                     |                                      |
| Admin: Delete provider                           | AlertDialog (exists)                        | routes break                         |
| Admin: Toggle provider enabled                   | undo toast                                  |                                      |
| Admin: Change user role                          | AlertDialog when granting or removing admin | security                             |
| Admin: Disable / delete user (when added)        | AlertDialog                                 |                                      |
| Operator: Suspend tenant                         | AlertDialog (new)                           | locks out a company                  |
| Operator: Activate tenant                        | neither, toast                              |                                      |
| Operator: Retry job                              | neither for one, AlertDialog for bulk       |                                      |
| Operator: Discard job                            | AlertDialog                                 |                                      |
| Live voice: turn on                              | Dialog (exists, key entry)                  |                                      |
| Live voice: turn off                             | neither, toast                              |                                      |

Undo toast implementation: `toast(text, { action: { label: "Undo", onClick } , duration: 6000 })` from sonner; the underlying call is sent immediately and the undo sends the inverse (status change, `return_area`, re-PUT routes), except attachment removal which defers the DELETE until the toast closes. Sonner's region is `aria-live`; the Undo button must be reachable: set `closeButton` and ensure `hotkey` (Alt+T) focuses the toaster (sonner default), documented in the keyboard help.

---

## 3. Design system completion (`src/app/globals.css`, `src/components/ui/*`)

### 3.1 Token changes for non-text contrast 3:1 (WCAG 1.4.11) and focus

Measured against white cards (`#ffffff`) and the canvas (`#f6f8fb`, L≈0.94):

| Token                        | Today                                                      | Contrast today | New value                                                 | Contrast new                                                                             | Where used                                                                                                      |
| ---------------------------- | ---------------------------------------------------------- | -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--input` (control boundary) | `#d5dce6`                                                  | 2.0:1 on white | `#7f8a99`                                                 | 3.5:1 white, 3.3:1 canvas                                                                | input, textarea, select trigger, combobox trigger, checkbox and radio border, switch track                      |
| `--input-hover` (new)        | —                                                          | —              | `#5b6b82` (= `--muted-foreground`)                        | 4.6:1                                                                                    | hover boundary                                                                                                  |
| `--shadow-control`           | `0 1px 1px rgb(10 37 64/.06), 0 0 0 1px rgb(10 37 64/.1)`  | about 1.3:1    | `0 0 0 1px var(--input), 0 1px 1px rgb(10 37 64 / 0.06)`  | 3.5:1                                                                                    | form controls only                                                                                              |
| `--shadow-button` (new)      | —                                                          | —              | the old `--shadow-control` value                          | decorative                                                                               | default/outline buttons, which are identified by their text and fill (1.4.11 does not require a boundary there) |
| `--switch-track` (new)       | `#c1c9d6` inline                                           | 1.6:1          | `var(--input)` `#7f8a99`                                  | 3.5:1 vs white; thumb white vs track 3.5:1                                               | `switch.tsx`                                                                                                    |
| checkbox border              | `#b8c2d0` inline                                           | 1.9:1          | `var(--input)`                                            | 3.5:1                                                                                    | `checkbox.tsx`                                                                                                  |
| `--ring`                     | `#635bff` used at 40% alpha (`ring-ring/40`)               | about 1.7:1    | `#635bff` solid, 2px, `outline-offset: 2px`               | 4.7:1 vs white; the 2px white offset gap separates it from same-coloured primary buttons | all `:focus-visible`                                                                                            |
| `--ring-dark`                | —                                                          | —              | `#a5a0ff`                                                 | ≥4.5:1 on `#0b1220`                                                                      | dark theme                                                                                                      |
| progress track/fill          | `--muted` / `--primary`                                    | 4.3:1          | keep                                                      |                                                                                          | `BudgetBar`, sessions progress                                                                                  |
| warning fill on track        | `#c47a00` on `#f1f4f8`                                     | 3.1:1          | keep, always with text                                    |                                                                                          |                                                                                                                 |
| `--secondary-hover` (new)    | `#e5eaf1` inline in `button.tsx`                           | —              | token                                                     |                                                                                          |                                                                                                                 |
| `--skeleton` (new)           | `#e8edf3` inline                                           | —              | token                                                     |                                                                                          |                                                                                                                 |
| `--overlay` (new)            | `#0a2540/40` inline ×3                                     | —              | `rgb(10 37 64 / 0.4)` token                               |                                                                                          | dialog, sheet, alert-dialog                                                                                     |
| `--brand-gradient` (new)     | inline in `AdminShell`, `InterviewScreen`, `CenteredShell` | —              | `linear-gradient(135deg, var(--primary), var(--chart-2))` |                                                                                          | brand marks and band                                                                                            |

Focus implementation: one rule in `@layer base`: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }` (exists with Tailwind's `outline-ring`, but components override it with `outline-none focus-visible:ring-ring/40 focus-visible:ring-[3px]`). Remove the per-component `outline-none focus-visible:ring-*` from `button`, `input`, `textarea`, `select`, `checkbox`, `radio-group`, `switch`, `tabs`, `badge`, `combobox`, `LanguageSwitch`, `Pagination` select, `OverrideSheet` select, `MessageBubble` listen button. Inputs additionally change their boundary to `--primary` on focus (exists as `focus-visible:shadow-[0_0_0_1px_var(--primary)]`), which is fine as a second cue. Destructive buttons keep `--ring`; the offset gap carries the contrast.

Inputs become visibly heavier than the Stripe look the owner chose (D-78). That is the cost of 1.4.11 and I recommend paying it: at 1px the `#7f8a99` boundary still reads as light, and hover/focus make it darker rather than lighter. The alternative (keep a 1.3:1 boundary and rely on labels) fails the Understanding document's reading of 1.4.11 for text inputs.

### 3.2 Motion

- Global rule in `globals.css`: `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; } }`. This neutralises `tw-animate-css` enter/exit classes on dialog, sheet, popover, select, tooltip, alert-dialog and the `Button` spinner without touching each file. Keep `motion-safe:` on the indicators that already have it. `MessageList` and `NavigationProgress` read `matchMedia("(prefers-reduced-motion: reduce)")` for JS-driven motion. Audit: `button.tsx` spinner `animate-spin` → `motion-safe:animate-spin motion-reduce:opacity-70` so the busy state still shows.
- No parallax, no autoplaying meters beyond the live-voice level meter (decorative, `motion-safe` only).

### 3.3 Panel vs Card vs Inset vs ChoiceTile

- `Panel` (`components/admin/Panel.tsx`): a titled container; header row with title/description/actions; content runs edge to edge (tables, lists, charts). Always has an `h2`/`h3`.
- `Card` (`components/ui/card.tsx`): padded free-form content, optional `CardHeader`. Use when there is no table and the title is optional.
- `Inset` (new, `components/ui/inset.tsx`): a grouping inside a Card/Panel: `bg-muted/50 rounded-lg p-3`, no border, no shadow. Replaces every ad-hoc `rounded-* border p-*`.
- `ChoiceTile` (new, `components/ui/choice-tile.tsx`): a selectable row/tile that wraps a radio or checkbox or acts as a button: `bg-card shadow-control rounded-lg p-3`, selected: `ring-2 ring-primary ring-offset-0 bg-accent`, keyboard focus from the inner control (`has-[:focus-visible]:outline`). Used by participant choices, path choice, widget options, weights presets.
- Never nest a Card in a Card or a Panel in a Panel; tables inside Cards lose their own frame (CSS rule exists).

Legacy bordered boxes to replace (verified by grep; the review's "28" counted three `border-0` controls and the progress chip, which are not boxes; the 24 real ones):

| File:line                                                | Today                                     | Replace with                                                       |
| -------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------ |
| `components/participant/ArrivalFlow.tsx:339`             | `rounded-lg border p-3` label             | `ChoiceTile`                                                       |
| `components/participant/PathChoice.tsx:39`               | `rounded-xl border p-4` button            | `ChoiceTile`                                                       |
| `components/participant/SummaryView.tsx:86`              | `rounded-2xl border p-5` section          | `Card`                                                             |
| `components/participant/AttachmentList.tsx:160`          | `rounded-lg border` li                    | `Inset`                                                            |
| `components/widgets/SingleChoiceWidget.tsx:45`           | `rounded-lg border p-3`                   | `ChoiceTile`                                                       |
| `components/widgets/MultiChoiceWidget.tsx:53`            | same                                      | `ChoiceTile`                                                       |
| `components/widgets/RankingWidget.tsx:54`                | `rounded-lg border p-2` li                | `Inset`                                                            |
| `components/widgets/ScaleWidget.tsx:44`                  | `rounded-lg border` button                | `ChoiceTile` (compact)                                             |
| `components/admin/requirements/FindingsList.tsx:115`     | `details rounded-lg border`               | `Inset`                                                            |
| `components/admin/requirements/VersionView.tsx:146`      | `details rounded-lg border`               | `Inset`                                                            |
| `components/admin/requirements/ConversationPane.tsx:154` | `rounded-2xl border p-4` widget box       | `Card` (matches participant)                                       |
| `components/admin/requirements/VersionDiff.tsx:28`       | `rounded-md border font-mono`             | `Inset` with `font-mono`                                           |
| `components/admin/requirements/VersionDiff.tsx:213`      | `rounded-md border p-2` li                | `Inset`                                                            |
| `components/admin/settings/LiveVoicePanel.tsx:138`       | `rounded-xl border p-4` section           | `Panel` (it has a title)                                           |
| `components/admin/results/WeightsPanel.tsx:47`           | `rounded-md border px-3 py-2` label       | `ChoiceTile`                                                       |
| `components/admin/results/OverrideSheet.tsx:107`         | `rounded-md border p-3`                   | `Inset`                                                            |
| `components/admin/templates/ListEditor.tsx:39`           | `bg-muted/30 rounded-lg border p-3`       | `Inset`                                                            |
| `components/admin/templates/TemplateDiff.tsx:27`         | `rounded-lg border p-3`                   | `Inset`                                                            |
| `components/admin/templates/TemplateForm.tsx:727`        | `border-input rounded-md border` textarea | `Textarea` primitive                                               |
| `components/admin/campaigns/InvitationsPanel.tsx:90`     | `rounded-md border` span-as-button        | `Button variant="outline"` wrapping a real file input              |
| `components/report/MermaidDiagram.tsx:59`                | placeholder `rounded-lg border p-6`       | `Skeleton`-styled `Inset`                                          |
| `components/report/MermaidDiagram.tsx:68`                | `figure rounded-lg border p-4`            | `Card`                                                             |
| `components/report/ReportView.tsx:127`                   | `fieldset rounded-lg border p-4`          | `Panel` titled "Sections"                                          |
| `components/participant/ProgressAreas.tsx:54`            | `rounded-full border` chip                | keep as a chip but use `shadow-control` so the boundary passes 3:1 |

### 3.4 Raw palette colours to tokens

`ui/alert-dialog.tsx:28`, `ui/dialog.tsx:30`, `ui/sheet.tsx:31` (`#0a2540/40` → `--overlay`); `ui/switch.tsx:15` (`#c1c9d6` → `--input`); `ui/checkbox.tsx:16` (`#b8c2d0` → `--input`); `ui/button.tsx:16` (`#e5eaf1` → `--secondary-hover`); `ui/skeleton.tsx:9` (`#e8edf3` → `--skeleton`); `AdminShell.tsx` Brand, `InterviewScreen.tsx` header mark, `CenteredShell.tsx` band (gradients → `--brand-gradient`, band uses a four-stop variant `--brand-band`). The existing `design-system.test.tsx` gains a test that greps `src/components` for `#[0-9a-f]{3,8}` and fails on any hit outside `globals.css`.

### 3.5 Dark mode readiness

The custom variant `@custom-variant dark (&:is(.dark *))` exists. Add a second token block that is applied both by `.dark` and by `@media (prefers-color-scheme: dark)` when no explicit `data-theme="light"` is set, and a three-way switch (System / Light / Dark) in the admin user box and the participant menu, stored in `localStorage` (per-viewer convenience) and applied before paint by a tiny inline script in `layout.tsx` to avoid a flash. Proposed values (to be validated by the contrast script in M3): `--background #0b1220`, `--card #111a2b`, `--popover #111a2b`, `--foreground #e6ebf2`, `--body #c3ccd9`, `--muted #182338`, `--muted-foreground #94a3b8` (4.6:1 on card), `--secondary #1b2740`, `--accent #221f4d`, `--accent-foreground #c7c3ff`, `--primary #8b85ff` with `--primary-foreground #0b1220` (7:1), `--primary-hover #9d98ff`, `--border #233047`, `--input #5b6b82` (3.3:1 on card), `--ring #a5a0ff`, `--destructive #ff5c7a`, `--destructive-soft #3a1420` / `-foreground #ffb3c1`, `--success #3ccf8e`, `--success-soft #0f2a1f` / `#9be7c4`, `--warning #f0a632`, `--warning-soft #2e2208` / `#ffd58a`, `--info-soft #0f2240` / `#9cc4ff`, `--overlay rgb(0 0 0 / 0.6)`, shadows become 1px borders (`--shadow-card: 0 0 0 1px var(--border)`), chart hues lightened one step. Components already use semantic tokens only, so the work is the token block, the switch, the inline script, and screenshots in both themes.

### 3.6 Empty-state illustrations

Policy: none. The one style is the existing `EmptyState` (icon in an accent circle, one sentence, optional action). The onboarding checklist uses numbered steps. Reason: illustrations need a second asset pipeline, dark-mode variants and translation of embedded text; the product's tone is calm and specific, which an icon plus a sentence that says what to do serves better. Every `EmptyState` sentence must include the next action or say why there is nothing ("No sessions yet. Share the link to start one.").

### 3.7 Density and typography

- Type scale (rem/px): 12 (meta, table header), 13 (table body meta, tile labels), 14 (body, admin default), 15 (participant bubbles, card titles), 16 (participant inputs and lg buttons; prevents iOS zoom), 20 (section h2), 24 (page h1), 28 (stat values). Remove 10px and 11px: `SpecPanel` tab badges (`text-[10px]`), `AdminShell` nav group labels and brand (`text-[11px]`), `ProvidersPanel` base URL (`text-[11px]`), `TenantsPanel` id (`text-[11px]`) → 12px. Line height 1.5 for body, 1.2 for h1, 1.65 for report prose (exists).
- Density: admin table rows 40px, controls 36px (`h-9`) default, 32px small; participant controls 44px. Touch targets meet 2.5.8 (24×24 minimum): checkbox 20px is acceptable because its label is part of the target; `MessageBubble` listen button is 26px high, fine; `IconButton` `icon-sm` is 32px, fine.
- Tabular numerals on all numbers (`tabular-nums` exists on tables and tiles).

### 3.8 Icon policy

Lucide only (installed). Sizes: 16px in buttons and tables, 20px in participant controls, 24px in `StatusScreen`. Every icon is `aria-hidden="true"` unless it is the sole content of a control, in which case the control has `aria-label` (the `IconButton` wrapper does this). Status is never conveyed by icon or colour alone: a `Badge` always has text; `StatusBadge` tones are redundant with the label. No emoji anywhere in UI strings. One icon per concept (campaign = megaphone, session = messages-square, template = file-text, requirements = clipboard-list, provider = server, route = route, budget = coins), recorded in `docs/design/icons.md`.

---

## 4. Content design

### 4.1 Product voice

- Calm: no exclamation marks, no "Oops", no "Great!". Confirmation is a plain statement ("Settings saved").
- Specific: name the object and the number ("3 invitations sent, 1 skipped as a duplicate"), name the place ("under Settings › Privacy").
- Second person, present tense, active voice: "You can pause at any time", not "Users may pause".
- The system speaks about itself as "we" only in the participant flow where a human organization is behind it ("We send a six-digit code"); the admin UI has no "we".
- Buttons are verbs with objects ("Send code", "Start the interview", "Save this category"); never "OK", "Submit", "Yes".
- Dialog titles are questions when they ask for a decision ("Finish the interview?"); confirm buttons repeat the verb ("Finish").
- Status lines use an ellipsis for ongoing work ("Sending…") and a full sentence for outcomes.
- Sentence case everywhere, including table headers (today `TableHead` uppercases via CSS; keep the CSS, write the strings in sentence case).
- Numbers and dates through `Intl` in the reader's locale (exists in `utils.ts`); currency from a setting (today EUR is hardcoded in `formatCents`; add `branding.currency` to the catalog).

Finnish: use sinuttelu (informal "sinä") for both participants and admins. `fi.ts` already does so consistently (20 sinuttelu forms, zero teitittely). Recommendation: keep it and record it, because Finnish public services and SaaS products (Kela, OP, Verohallinto, Slack fi) address users with sinä, and teitittely would read as distant in a conversation about someone's own work. Finnish rules: compound nouns closed (`sähköpostiosoite`), avoid anglicisms where a Finnish term exists (`kampanja` is fine, `sessio` is not), no capitalised common nouns in titles, en dash with spaces for ranges, dates `13.10.2026`, decimal comma via `Intl`.

### 4.2 Terminology glossary (en → fi, with the rule)

| English                     | Finnish                                                               | Use                                                                                |
| --------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| campaign                    | kampanja                                                              | a set of interviews under one template and link                                    |
| session                     | haastattelu (participant-facing), istunto (admin lists, requirements) | one person's interview; admins see "istunto" where the technical object is meant   |
| participant                 | osallistuja                                                           | never "user" or "respondent"                                                       |
| interviewer                 | haastattelija                                                         | the AI; never "bot" or "assistant" in UI                                           |
| opportunity                 | mahdollisuus                                                          | an analysed cluster; never "idea"                                                  |
| finding                     | havainto                                                              | issue-detection output in requirements                                             |
| specification               | määrittely                                                            | the live spec and its versions; "vaatimusmäärittely" only in the product-area name |
| hand-off                    | siirtotiedot                                                          | the object passed from discovery to requirements                                   |
| template                    | malli (haastattelumalli in headings)                                  |                                                                                    |
| coverage area               | aihealue                                                              | the progress chips                                                                 |
| route                       | reitti                                                                | purpose → provider/model                                                           |
| purpose                     | käyttötarkoitus                                                       | interview, extraction, embedding…                                                  |
| budget                      | budjetti                                                              |                                                                                    |
| provider                    | palveluntarjoaja                                                      | model provider; "malli" is the model itself                                        |
| analysis                    | analyysi                                                              | a versioned run                                                                    |
| report                      | raportti                                                              |                                                                                    |
| requirements (product area) | vaatimukset                                                           | nav label                                                                          |
| invitation                  | kutsu                                                                 |                                                                                    |
| tenant (operator only)      | asiakasorganisaatio                                                   | "organisaatio" when speaking to the tenant itself                                  |
| platform operator           | alustan ylläpitäjä                                                    |                                                                                    |
| member / admin              | jäsen / pääkäyttäjä                                                   |                                                                                    |
| live voice                  | äänipuhelu                                                            | not "reaaliaikainen ääni"                                                          |
| recorded answer             | äänivastaus                                                           |                                                                                    |
| delete my data              | poista tietoni                                                        |                                                                                    |
| pause / resume              | keskeytä / jatka                                                      |                                                                                    |
| I'm done                    | olen valmis                                                           |                                                                                    |

### 4.3 Error message rules

Every error shown to a person has three parts, in this order, each one sentence: what happened (plain words, no codes), what to do, what we kept. Codes and request ids go in a muted last line for support only. Never blame the person ("invalid input"); describe the mismatch ("The key must be lowercase letters and underscores").

Mapping of API codes to the three parts (participant / admin wording direction):

| Code                                          | What happened                                                       | What to do                                                       | What we kept                     |
| --------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------- |
| `network_error` (offline)                     | You seem to be offline                                              | We retry when you are back online; or tap Retry                  | Your answer is kept here         |
| `provider_error`                              | The interviewer is temporarily unavailable                          | Try again in a moment                                            | Nothing you said is lost         |
| `budget_exceeded`                             | The interview is paused: the organization's usage limit was reached | Come back later; the organizer sees this                         | Your answers are saved           |
| `rate_limited`                                | Too many attempts                                                   | Wait a minute and try again                                      | —                                |
| `unauthenticated` / `not_found` (participant) | This session is no longer available                                 | Open your link again or ask for a new one                        | —                                |
| `conflict` 409 (admin)                        | Something is already running / this changed since you opened it     | Wait or reload to see the latest                                 | Your edits are kept in the form  |
| `validation` (admin)                          | field-level: the rule, in words                                     | fix the field (focus moves there)                                | —                                |
| `too_large`                                   | That file is larger than N MB                                       | Try a smaller file                                               | Your other files are kept        |
| `forbidden`                                   | You do not have access to this                                      | Ask an admin for the role                                        | —                                |
| `voice_not_ready`                             | Live voice needs a transcription and a speech route                 | Connect an OpenAI key or set the routes                          | Nothing was turned on            |
| `invalid_api_key`                             | OpenAI did not accept this key                                      | Check it and try again                                           | Nothing was stored               |
| `internal` / 5xx                              | Something went wrong on our side                                    | Try again; if it keeps happening, tell your admin (reference id) | Your work is kept where possible |

Implementation: `lib/api/errors.ts#errorMessage` becomes `errorParts(e, audience): { what, next, kept? , ref? }` with the mapping in `i18n/*.errors`, and `Alert` gets an `ErrorBody` child that renders the three parts. API messages are never shown verbatim to participants; admins see the API message as the muted detail line.

### 4.4 Raw enum call sites and the i18n key structure

Introduce `t.enums` in `en.ts` and `fi.ts`, one object per domain, and a `label(domain, value)` helper that falls back to the raw value in `font-mono` with `aria-label="identifier"` (never `humanize`). Lint: `no-restricted-syntax` forbidding `humanize(` outside `lib/utils.ts` and a test that every value of the shared enums (`PURPOSES`, `PROVIDER_KINDS`, `SOLUTION_CLASSES`, `FACT_KINDS`, `SETTING_SCOPES`, statuses) has en and fi labels.

```
t.enums = {
  purpose: { interview, extraction, summary, resume_summary, analysis, report, spec_generation, embedding, transcription, stt_stream, tts, ... },
  providerKind: { openai, anthropic, openrouter, local, ... },
  effort: { low, medium, high },
  settingScope: { platform, tenant, campaign, template },
  budgetScope: { tenant, campaign, session },
  budgetPeriod: { month, total },
  routeSource: { tenant, platform, none },
  priceSource: { seed, provider, admin },
  coverageStatus: { untouched, partial, covered, skipped },
  language: { en, fi },
  specSection: { overview, users, stories, functional, ... },
  statGroup / statKey: { participation, discovery, requirements, ai, health; invited, started, ... },
  spendKey (purpose or model or campaign names pass through),
  settingKey: { "engine.maxTurns": { label, description }, ... }   // every SETTINGS key
}
```

Call sites to convert (file:line → key):

1. `app/admin/page.tsx:182` spend by purpose label → `enums.purpose`
2. `app/admin/campaigns/[id]/page.tsx:107` drop-off area key → template area names from the campaign (`campaign.template.coverageAreas`), fallback `enums.coverageArea`
3. `components/admin/StatsGroups.tsx:46,50` group label → `enums.statGroup`
4. `StatsGroups.tsx:56,61,65,72` stat keys → `enums.statKey`
5. `components/admin/SpendPanel.tsx:78` → `enums.purpose` / model passthrough
6. `components/admin/StatusBadge.tsx:43` fallback → monospace identifier, not `humanize`
7. `components/admin/settings/CategoryForm.tsx:245` setting label → `enums.settingKey[key].label`
8. `CategoryForm.tsx:315` weights keys → `t.admin.results.factors[k]` (exists)
9. `CategoryForm.tsx:349` enum option values → `enums.settingValue[key][v]` (per-key value labels, e.g. `cost.onBudgetExceeded: pause`)
10. `components/admin/settings/SettingsCategories.tsx:27` category fallback → `t.admin.settings.categories` must be complete; drop fallback
11. `components/admin/providers/BudgetsPanel.tsx:115` scope options → `enums.budgetScope`
12. `BudgetsPanel.tsx:186` scope cell → `enums.budgetScope`
13. `components/admin/providers/RoutesForm.tsx:217` purpose cell → `enums.purpose`
14. `RoutesForm.tsx:224,246,269,288,301,319` aria-labels with purpose → `enums.purpose`
15. `RoutesForm.tsx` effort `SelectItem` renders `{e}` raw → `enums.effort`
16. `components/admin/requirements/SpecSections.tsx:49` section key → `enums.specSection`
17. `components/admin/providers/ProvidersPanel.tsx:114` `{p.kind}` badge → `enums.providerKind`
18. `ProvidersPanel.tsx` provider options `detail: pr.kind` in `RoutesForm` → `enums.providerKind`
19. `app/admin/providers/[id]/page.tsx:40` subtitle `provider.kind` → `enums.providerKind`
20. `app/admin/operator/providers/[id]/page.tsx:40` same
21. `app/admin/templates/[id]/page.tsx:63` `tpl.language` → `enums.language`
22. `components/admin/requirements/VersionDiff.tsx:74` `{r.scope}` (mvp/future) → `t.admin.requirements.scopes`
23. `app/admin/sessions/[id]/page.tsx` `m.areaKey` under messages → area name from the session's template progress
24. `app/admin/sessions/[id]/page.tsx` `ev.type` event type → `enums.eventType` with the raw type as `title`
25. `components/admin/campaigns/SessionsTable.tsx` id prefix as participant → "Anonymous · ab12cd34" via a string
26. `components/admin/results/AnalysisHeader.tsx` embedding kind (handled) — keep
27. `components/admin/operator/TenantsPanel.tsx` region `tn.region` → `enums.region` (eu, …) with passthrough
28. `components/admin/results/OpportunityCard.tsx` `o.stats.roles`/`tools` are data, keep; `dismissed` etc. via `s.statuses` (exists)

Plus the currency hardcode in `lib/utils.ts#formatCents` → `branding.currency` setting.

---

## 5. Evidence plan

### 5.1 Automated accessibility: axe-core in Playwright

- Add `apps/web/e2e/` with `@playwright/test` and `@axe-core/playwright`; `playwright.config.ts` with four projects: `en-mobile` (Pixel 7, 390×844), `en-desktop` (1280×800), `fi-mobile`, `fi-desktop`; the `fi` projects set the `lang=fi` cookie in `storageState`. Also a `reduced-motion` project (`reducedMotion: "reduce"`) and a `dark` project (`colorScheme: "dark"`) for the participant flow and dashboard.
- Page inventory (every route, every state reachable with fakes): participant arrival (identified/anonymous/choice; email_code/invitation/open), email, code (wrong code, resend), details, consent, path, interview states from the table in 1.5 (first-turn, streaming, awaiting with each of five widgets, recording, uploading, attachment-failed, error-retryable, offline, budget-paused, ended, summary), live voice screen (connecting, listening, speaking, lost), recap banner, paused, deleted, closed, expired, invalid, revoked, completed invite, 404 under `/p`, root 404; admin: sign-in, verify, dashboard (empty with checklist, populated), campaigns list (empty, filtered), new campaign (validation errors), campaign page ×5 tabs, edit campaign, session detail (flagged), results (no analysis, running, done, merge mode, override sheet, promote dialog), report (sections), requirements list/new/workspace (spec, findings, versions)/version page/GitHub dialog, templates list/detail/edit (error summary)/new, settings (each category, each scope, what-changed, search, dirty dialog), providers (list, add dialog, test running/ok/failed, models/prices), routes, budgets, users, audit, operator tenants/providers/routes/stats/jobs.
- Each test: navigate or drive to the state, `await new AxeBuilder({ page }).withTags(["wcag2a","wcag2aa","wcag21a","wcag21aa","wcag22aa","best-practice"]).analyze()`, assert `violations.length === 0`, and save the axe JSON to `e2e-results/axe/<project>/<page>.json`. A summary step writes `docs/design/evidence/axe-summary.md` (pages × projects, violations) for the review.
- Manual checks axe cannot do, scripted as Playwright assertions where possible: focus order per screen (`expect(locator).toBeFocused()` after each step), the single announcement (count `role="status"` text changes during a streamed turn: exactly one), reduced motion (computed `animation-duration`), target sizes (bounding boxes ≥ 24×24 for every `button, a, [role=button]`), zoom 200% (viewport 640 at `deviceScaleFactor 2`, no horizontal scroll), high-contrast forced colors (`forcedColors: "active"`, screenshot review), screen reader passes with VoiceOver (iOS Safari) and NVDA (Firefox) recorded as a checklist in `docs/design/evidence/sr-checklist.md` with date and tester.

### 5.2 Playwright e2e journeys against the dev stack with fakes

- Dev stack: `docker compose -f deploy/compose.dev.yml` (or the existing dev commands) with the API started with a deterministic `fake` model provider kind (the adapters have in-memory fakes for tests; e2e needs the same fake behind the HTTP API: a `MODEL_FAKE=1` env that registers a scripted provider returning canned turns with widgets for the seeded templates, plus a fake transcription returning "canned transcript" and a fake TTS returning silence). Flag as API work. Email goes to the dev mail catcher; the e2e reads the code from its API.
- Journeys (one spec file each, run in both locales on mobile and desktop):
  1. Participant: open link → code → details → consent → three turns (text, single choice, scale) → skip an area (chip appears, no participant bubble) → record an answer (fake MediaRecorder via `page.addInitScript`) → attach a file → pause → reopen (recap banner) → I'm done (dialog) → edit summary → delete data (dialog) → deleted screen; assert no `role="status"` double announcements, the transcript in the admin shows control chips.
  2. Participant live voice: start call (fake WebSocket frames), captions appear, stop interviewer, type instead, session continues.
  3. Admin first run: fresh tenant → checklist → connect provider → copy template → publish → create campaign → link → (participant completes two sessions in the same test) → analyze → results → promote → requirements workspace opens.
  4. Admin campaign lifecycle: edit campaign, invitations (send, remind, revoke with dialog), sessions filter and flag, close campaign (dialog), export Markdown.
  5. Admin template editor: introduce two validation errors, submit, assert error summary focus, click a summary link focuses the field, fix, save, restore previous version.
  6. Admin results: weights change re-ranks and saves, override sheet, dismiss with undo, merge two (when API exists), department panel hidden below k.
  7. Admin settings: scope change navigates, dirty guard blocks a category change, what-changed panel lists a key with `since` newer than last visit, search jumps to a key.
  8. Admin providers/routes/budgets: add provider, test connection toast, set a route with the combobox, add budget, bar renders with text.
  9. Operator: suspend tenant (dialog), retry a dead-lettered job.
- Each journey records a trace and video on failure; CI runs them in `.github/workflows` after the unit suite with Postgres and the fake provider.

### 5.3 Lighthouse budgets

- `@lhci/cli` with `lighthouserc.json`: URLs: `/p/<seeded link>`, `/p/session` (with cookie), `/admin`, `/admin/campaigns/<id>/results`, `/admin/settings`. Mobile emulation for participant URLs, desktop for admin. Assertions: `categories:accessibility` = 1.0 (error), `categories:performance` ≥ 0.9 participant / ≥ 0.85 admin, `largest-contentful-paint` ≤ 2500 ms participant, `total-blocking-time` ≤ 200 ms, `cumulative-layout-shift` ≤ 0.05, `interactive` ≤ 3500 ms; resource budgets in `budgets.json`: participant route script ≤ 250 KB gzipped (mermaid must stay out of the participant bundle), total ≤ 600 KB, admin script ≤ 450 KB, fonts ≤ 120 KB (two Inter weights). Reports saved to `docs/design/evidence/lighthouse/`.

### 5.4 Usability test script (5 participants, 3 admins)

- Participants (recruit: office workers, two with no prior exposure, one screen-reader user, one Finnish-only, one on an older Android): 30 minutes each, remote, phone. Tasks: (1) open the link from an email and start; (2) answer three questions however you like; (3) answer one by voice; (4) skip a topic you do not want to discuss; (5) close the tab and come back; (6) finish and check what was captured; (7) delete your data. Metrics per task: success (unassisted / assisted / fail), time, one-question SEQ (1–7), observed errors; post-test SUS; three open questions ("What did you think happened to your email?", "Did it ever feel like it was not listening?", "What would make you trust it more?").
- Admins (recruit: an HR/operations lead, a product manager, an IT admin; one Finnish): 45 minutes, desktop. Tasks: (1) you have a fresh account: get to a shareable interview link; (2) change the maximum number of turns for this campaign only; (3) invite three people and withdraw one invitation; (4) after we add results, find the strongest opportunity and send it to requirements; (5) in the template, make the "role" area essential and save; (6) find where to set a monthly budget and set €200. Same metrics plus "where did you expect that to be?" probes.
- Targets that define 9.5/10 for this plan: ≥ 90% unassisted task success, median SEQ ≥ 6, SUS ≥ 80, zero WCAG AA violations across the inventory, no participant task over 2× the expert time. Results go in `docs/design/evidence/usability-2026-MM.md` with the raw sheet.

### 5.5 Screenshot gallery for review

- `pnpm --filter @aidp/web screenshots`: a Playwright script that drives every page/state in the inventory in `en`/`fi`, light/dark, 390/1280 and writes `docs/design/screens/<flow>/<state>.<locale>.<theme>.<width>.png` plus a generated `docs/design/screens/README.md` grid. Committed PNGs are kept small (JPEG quality 80 for admin, PNG for participant) and regenerated per milestone; the existing stray `phase4-files.png` in the repo root moves here or is deleted.

---

## 6. Milestone plan

Effort in working days for one engineer or agent. "API" marks work outside `apps/web` that must land first or in the same change.

### M1 — fix critical and high usability issues (9 to 11 days)

| #    | Work                                                                                                                                                                                                                                              | Files                                                                                                                                    | Days | Depends on                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| 1.1  | Server locale on every page (await `getStrings()`)                                                                                                                                                                                                | all `app/**/page.tsx`, `not-found.tsx`, `error.tsx`                                                                                      | 0.5  | —                                                                                    |
| 1.2  | Tokens: `--input #7f8a99`, `--shadow-control` boundary, `--shadow-button`, solid 2px focus outline with offset, remove per-component ring classes, `--overlay`, `--secondary-hover`, `--skeleton`, `--brand-gradient`; global reduced-motion rule | `globals.css`, `ui/*` (18 files), `AdminShell`, `CenteredShell`, `InterviewScreen`                                                       | 1.5  | —                                                                                    |
| 1.3  | `Alert` `role` prop (alert vs status) and use it                                                                                                                                                                                                  | `ui/alert.tsx`, call sites                                                                                                               | 0.5  | —                                                                                    |
| 1.4  | Streaming announcer, list semantics, system chips, reduced-motion scroll                                                                                                                                                                          | `MessageList.tsx`, `useInterview.ts`                                                                                                     | 1    | —                                                                                    |
| 1.5  | `ModeSwitch` → Radix ToggleGroup; `mode_switch` event                                                                                                                                                                                             | `ModeSwitch.tsx`, `lib/api/participant.ts`                                                                                               | 0.5  | API: write `mode_switch` SessionEvent in `POST /p/session/mode` (0.25)               |
| 1.6  | Control operations: skip/return/finish as state ops; undo toast; "I'm done" dialog; service hack removed                                                                                                                                          | `useInterview.ts`, `InterviewScreen.tsx`, `ProgressAreas.tsx`, `SessionMenu.tsx`, `lib/api/sse.ts`                                       | 1.5  | API/engine: `TurnBody.control`, `UserAnswer.control`, `SessionState.requestedAreaKey | completionRequested`, `chooseFocus`, `context.ts`, `control` SSE event, D-81, contract 16 patch, engine tests and an evals replay (2) |
| 1.7  | Composer coarse-pointer newline rule, deferred clear, keyboard hint                                                                                                                                                                               | `Composer.tsx`, `hooks/useCoarsePointer.ts`                                                                                              | 0.5  | —                                                                                    |
| 1.8  | Offline state and `useOnline`                                                                                                                                                                                                                     | `InterviewScreen.tsx`, `hooks/useOnline.ts`, i18n                                                                                        | 0.5  | —                                                                                    |
| 1.9  | Participant 404 and root 404; `p/error.tsx` copy and digest                                                                                                                                                                                       | `app/p/not-found.tsx`, `app/not-found.tsx`, `app/p/error.tsx`                                                                            | 0.5  | —                                                                                    |
| 1.10 | Confirmations: close campaign, revoke invitation (both), suspend tenant, role change, bulk invitations; undo toasts for dismiss/shortlist/restore, clear override, remove attachment                                                              | `CampaignActions`, `InvitationsPanel`, `InvitationsSection`, `TenantsPanel`, `UsersPanel`, `ResultsView`, `RoutesForm`, `AttachmentList` | 1    | —                                                                                    |
| 1.11 | Form validation pattern: `ErrorSummary`, focus to first error, section error counts                                                                                                                                                               | `forms.tsx`, `TemplateForm`, `CampaignForm`, `RequirementsForm`, `ArrivalFlow` field errors                                              | 1.5  | —                                                                                    |
| 1.12 | Dirty guard context and `beforeunload`; wire settings, template, campaign, override sheet                                                                                                                                                         | `components/common/DirtyGuard.tsx` + four forms                                                                                          | 1    | —                                                                                    |
| 1.13 | Scope picker navigates on change                                                                                                                                                                                                                  | `ScopePicker.tsx`                                                                                                                        | 0.25 | —                                                                                    |
| 1.14 | Focus to `h1` on step and status screens                                                                                                                                                                                                          | `ArrivalFlow`, `InviteArrival`, `StatusScreen`                                                                                           | 0.25 | —                                                                                    |

### M2 — complete the redesign and the content (16 to 19 days)

| #    | Work                                                                                                                                                                                                         | Files                                                                                                            | Days | Depends on                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `Inset`, `ChoiceTile`; replace the 24 bordered boxes; raw-hex test                                                                                                                                           | `ui/inset.tsx`, `ui/choice-tile.tsx`, 24 files, `test/design-system.test.tsx`                                    | 1.5  | 1.2                                                                                                                                                                                            |
| 2.2  | `t.enums` en/fi, `label()` helper, convert 28 call sites, lint rule, coverage test, `branding.currency`                                                                                                      | `i18n/en.ts`, `fi.ts`, `lib/i18n/enums.ts`, 20 files, `eslint.config.js`                                         | 2    | shared: `branding.currency` key (0.25)                                                                                                                                                         |
| 2.3  | Settings key labels for every catalog key (en/fi) and coverage test; what-changed panel; search; `since`                                                                                                     | `CategoryForm`, `WhatChangedPanel`, `SettingsSearch`, i18n                                                       | 2    | shared/API: `SettingDef.since`, catalog includes it (0.5)                                                                                                                                      |
| 2.4  | Resume recap banner and paused recap                                                                                                                                                                         | `RecapBanner.tsx`, `InterviewScreen.tsx`, `schemas.ts`                                                           | 0.5  | API/AI: `recap` in `GET /p/session`, `recap.v1` prompt, cache in state, evals fixture (1.5)                                                                                                    |
| 2.5  | Live voice full-screen mode                                                                                                                                                                                  | `LiveVoiceScreen.tsx`, `LiveVoiceCall.tsx`, `useLiveVoice.ts`, `InterviewScreen.tsx`                             | 2.5  | — (uses existing socket frames); optional API: `speakingText` caption frame if not already sent                                                                                                |
| 2.6  | Consent checkbox in `ArrivalFlow`, resend cooldown, "Other" with speech, arrival voice line                                                                                                                  | `ArrivalFlow.tsx`, `OtherInput.tsx`, widgets                                                                     | 1    | API: `capabilities` on `GET /p/:linkToken` (0.25); `POST /p/session/transcribe` (0.5)                                                                                                          |
| 2.7  | Summary pending state; delete response `emailSent` wording                                                                                                                                                   | `SummaryView.tsx`, `InterviewScreen.tsx`                                                                         | 0.5  | API: `{ emailSent }` from `DELETE /p/session` once the email exists (tier 4)                                                                                                                   |
| 2.8  | Onboarding checklist and `ui.onboardingDismissed`                                                                                                                                                            | `SetupChecklist.tsx`, `app/admin/page.tsx`                                                                       | 1.5  | shared: catalog key (0.1)                                                                                                                                                                      |
| 2.9  | Campaign lifecycle page: tabs, edit page, overview (QR, threshold meter, analysis card, spend), invitations fixes, sessions toolbar + participant/mode/flag columns, settings tab, analysis tab with exports | `app/admin/campaigns/[id]/**`, `components/admin/campaigns/*`, `components/admin/BudgetBar.tsx`                  | 3    | API: `flagged`, `lastModality` on sessions rows; `flaggedForAdmin` on session detail (0.5); `GET /campaigns/:id/sessions.csv` (0.5); report PDF `GET /analyses/:id/report.pdf` via Kroki (1.5) |
| 2.10 | Template editor: section rail, versions panel, two-body diff, restore, phone preview badge                                                                                                                   | `TemplateForm`, `ListEditor`, `TemplateDiff`, `templates/VersionsPanel.tsx`, `app/admin/templates/[id]/page.tsx` | 2    | API: `POST /templates/:id/restore` (0.5; client fallback exists); `preview: true` in session response (0.25)                                                                                   |
| 2.11 | Results: "AI is not the answer" section, dashboard Not-AI tile, override sheet polish, merge/split UI behind capability, departments panel                                                                   | `ResultsView`, `OpportunityCard`, `MergeBar.tsx`, `DepartmentsPanel.tsx`, `DiscoveryTiles`                       | 2    | API: merge/split endpoints writing overrides (2); `GET /analyses/:id/departments` with k (1); `byClass.none` in `/stats` (0.25)                                                                |
| 2.12 | Requirements: enums in spec sections and findings, MVP progress, exports panel with PDF, invitation dialog                                                                                                   | `SpecSections`, `FindingsList`, `MvpProgress.tsx`, `ExportsPanel.tsx`, `VersionView`                             | 1    | API: `mvpChallenge` in detail (0.25); spec PDF export (1, shares the Kroki service with 2.9)                                                                                                   |
| 2.13 | Providers/routes/budgets: toast on test success, budget bars, routes as cards on phones, base URL hint                                                                                                       | `ProvidersPanel`, `RoutesForm`, `BudgetsPanel`                                                                   | 1    | —                                                                                                                                                                                              |
| 2.14 | Operator: tenant dialog, jobs page                                                                                                                                                                           | `TenantsPanel`, `app/admin/operator/jobs/page.tsx`, `components/admin/operator/JobsPanel.tsx`                    | 1    | API: `GET /operator/jobs`, retry, discard over pg-boss (1.5)                                                                                                                                   |
| 2.15 | Dark theme tokens, theme switch, pre-paint script                                                                                                                                                            | `globals.css`, `layout.tsx`, `components/common/ThemeSwitch.tsx`, `AdminShell`, `SessionMenu`                    | 1    | —                                                                                                                                                                                              |
| 2.16 | Typography scale cleanup (no 10/11px), icon doc, EmptyState sentences, error three-part body                                                                                                                 | `SpecPanel`, `AdminShell`, `ProvidersPanel`, `TenantsPanel`, `errors.ts`, `Alert`, i18n, `docs/design/icons.md`  | 1    | —                                                                                                                                                                                              |
| 2.17 | Docs: decisions D-81 (control ops), D-82 (contrast tokens and focus), D-83 (confirmation policy), D-84 (sinuttelu and glossary); spec 06/07/19 patches; README design table additions                        | `docs/discovery/decisions.md`, `docs/spec/*`, `apps/web/README.md`, `docs/design/content-guide.md`               | 1    | —                                                                                                                                                                                              |

### M3 — evidence and polish (7 to 9 days)

| #   | Work                                                                                                                              | Files                                                                  | Days                          | Depends on                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 3.1 | Playwright + axe setup, four locale/viewport projects, reduced-motion and dark projects, page inventory tests, axe summary writer | `apps/web/e2e/**`, `playwright.config.ts`, `package.json`, CI workflow | 2                             | API: `MODEL_FAKE` scripted provider, fake transcription/TTS, mail-catcher code lookup for e2e (1.5) |
| 3.2 | Nine e2e journeys                                                                                                                 | `apps/web/e2e/journeys/*.spec.ts`                                      | 2.5                           | 3.1                                                                                                 |
| 3.3 | Lighthouse CI with budgets                                                                                                        | `lighthouserc.json`, `budgets.json`, CI                                | 0.5                           | 3.1 stack                                                                                           |
| 3.4 | Contrast script (computes every token pair in light and dark from `globals.css` and fails under 4.5/3)                            | `apps/web/scripts/contrast.ts`, test                                   | 0.5                           | 2.15                                                                                                |
| 3.5 | Screenshot gallery script and `docs/design/screens`                                                                               | `apps/web/scripts/screenshots.ts`, docs                                | 0.5                           | 3.1                                                                                                 |
| 3.6 | Screen-reader checklist runs (VoiceOver iOS, NVDA Firefox) and fixes                                                              | `docs/design/evidence/sr-checklist.md`                                 | 1                             | M2                                                                                                  |
| 3.7 | Usability tests (5 + 3), report, fix list                                                                                         | `docs/design/evidence/usability-*.md`                                  | 2 (plus recruiting lead time) | M2                                                                                                  |
| 3.8 | Polish from 3.6 and 3.7; final status doc update with scores and evidence links                                                   | various; `docs/team/status-*.md`                                       | 1                             | 3.6, 3.7                                                                                            |

### API and shared work summary (flag list)

New or changed endpoints and contracts, in the order the web needs them: `POST /p/session/turns` `control` body and `control` SSE event, engine state ops (M1); `mode_switch` event (M1); `GET /p/:linkToken` `capabilities` (M2); `GET /p/session` `recap` and `preview` (M2); `POST /p/session/transcribe` (M2); `DELETE /p/session` `{ emailSent }` (M2, with the deletion email); `SettingDef.since` and catalog keys `ui.onboardingDismissed`, `branding.currency` (M2); sessions list `flagged`, `lastModality` and session detail `flaggedForAdmin` (M2); `GET /campaigns/:id/sessions.csv` (M2); `GET /analyses/:id/report.pdf` and `GET /requirements/:id/versions/:v/export.pdf` via Kroki (M2); `POST /templates/:id/restore` (M2); `POST /analyses/:id/opportunities/merge`, `POST /opportunities/:id/split`, `GET /analyses/:id/departments` (M2); `/stats` `byClass.none` (M2); `mvpChallenge` in requirements detail (M2); `GET /operator/jobs`, retry, discard (M2); `MODEL_FAKE` scripted provider and fake speech adapters for e2e (M3). Everything else in this plan is `apps/web` only.

Total: roughly 32 to 39 engineering days for the web work, plus about 12 days of API and engine work listed above, of which the control operations, the recap, the hostility flag, the `since` field and the e2e fake provider are the ones the web cannot ship around.
