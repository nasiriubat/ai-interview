# Content guide

How the product speaks, in English and Finnish. It is the short, enforceable version of the copy
audit (`docs/team/plan/copy-audit.md`) and the content section of the UX plan
(`docs/team/plan/ux-design.md` section 4). The vocabulary is in [glossary.md](./glossary.md); the
decisions are D-130 to D-137 in `docs/discovery/decisions.md`.

Every user-facing string lives in `apps/web/src/i18n/en.ts` (the type source) and `fi.ts`
(declared as `Strings`, so a missing or extra key fails `tsc`). Components read them through `t`.

## Who is speaking

- The **product** speaks as "we", and only in the participant flow, where a human organization is
  behind it ("We will email you a six-digit code"). The admin has no "we".
- The **interviewer** is a third party the product introduces: "The interviewer is thinking". The
  product never says "we" about something the interviewer does. Inside the chat the interviewer
  speaks in the first person (prompt v4) and is warm, brief and specific; the text around it must
  not be louder than it is.
- Second person, present tense, active voice: "You can pause at any time", not "Users may pause".

## Principles

1. **Say what happened, what to do, what we kept**, in that order. Every error has all three, or is
   a single word.
2. **Promise only what the code does.** If a sentence cannot be checked against the implementation
   (deletion scope, emails, who can read what), cut it. `apps/web/test/copy-truth.test.ts` holds the
   facts the old strings got wrong.
3. **No internal nouns in front of participants**: session, campaign, purpose, route, engine,
   widget, cluster, fact, delta, worker, token, shipped. Admins may see "template", "campaign",
   "provider", "budget", "task"; never "purpose", "route", "scope" or "tenant" (operators excepted).
4. **Plain verbs over nouns**: "Deleting removes your answers" rather than "Deletion is immediate";
   "Who can answer" rather than "Verification".
5. **Specific over generic**: "Your answers are saved" beats "Nothing was lost". Numbers and names
   where we have them.
6. **Calm, not cheerful.** No exclamation marks, no "Great!", no "please" padding, no marketing
   adjectives. Gratitude once, at the end.
7. **Empty states teach the next step in one sentence.** Destructive confirmations name the
   consequence, not the mechanism.
8. **One term per concept** (the glossary). Labels are nouns; buttons are verbs with objects; status
   chips are adjectives or participles. Never "OK", "Submit" or "Yes" as a button.
9. **Dialog titles are questions** when they ask for a decision ("Finish the interview?"); the
   confirm button repeats the verb ("Finish").
10. **Accessibility text describes state, not chrome**: "The interviewer is answering", not "Answer
    is streaming".
11. **Sentence case everywhere**, including table headers. Numbers, dates and currency go through
    `Intl` in the reader's language.

## Error messages

Every error a person sees has three parts, each one sentence:

| Part          | Rule                                                     | Example                                     |
| ------------- | -------------------------------------------------------- | ------------------------------------------- |
| What happened | Plain words, no codes, never blame the person            | The interviewer is temporarily unavailable. |
| What to do    | One concrete action                                      | Try again in a moment.                      |
| What was kept | What the person has not lost, only when it is true there | Your answers are saved.                     |

- Participants never read the API's message: it is English, written for a log, and may name things
  they should not see. `participantErrorFor(code, context)` in `apps/web/src/lib/api/errors.ts`
  picks the three sentences from the API code and the screen the person is on (`arrival`,
  `interview`, `summary`), from `participant.errors` in the locale files.
- "What was kept" depends on the screen. On the arrival flow it is "What you entered is still here";
  in the interview it is "Your answers are saved"; on the summary it is "Your edits are still on
  this page". Where nothing is kept, the sentence is left out rather than invented.
- A code or a request reference goes on a muted last line, for support only.
- Describe the mismatch instead of the fault: "The key may contain lowercase letters and
  underscores", not "Invalid input".
- Admin errors may show the API message as the detail line under a plain-language sentence.

## Empty states

One sentence that says what is missing and what to do next, naming the control that does it:

- "No campaigns yet. Create one to get a link you can share with participants."
- "No interviews yet. They appear here as soon as someone opens the link."

Not "No campaigns yet." A list that is empty because of filters says so and points at the clear
button ("No opportunities match the current filters. Clear them to see every opportunity.").

## Identifiers are never spelled out by machine

An identifier from the API or a shared enum (a provider kind, a task, an effort level, a budget
scope, a template field, a setting key) is shown through `label(kind, value)` or `<EnumLabel />`
(`apps/web/src/lib/i18n/enums.ts`), backed by `t.enums`. `humanize()` no longer exists: it produced
English whatever the language and read like a translation that was never made.

- An identifier nobody has named yet comes back as itself, and `EnumLabel` shows it as code, so it
  never looks translated.
- Every setting of the catalog has a name and a one-sentence description in `t.enums.settingKey`,
  typed against `SettingKey`; a new catalog key fails `tsc` until it has words in both languages.
  Options of enum-valued settings are in `t.enums.settingValue`.
- `apps/web/test/enums.test.ts` fails when a member of a shared enum, a catalog key or an option has
  no label in a language, and when `humanize` is used anywhere in `src`.
- Data that belongs to a template (coverage-area names, background questions) is resolved from the
  template first; `t.enums.coverageArea` and `contextKey` are only the fallback for the shipped ones.

## Finnish

- **Sinuttelu** (informal "sinä") for participants and admins alike. It is the norm for Finnish
  SaaS and matches the interviewer's register. No teitittely.
- **Yleiskieli**, not selkokieli (selkokieli is a regulated register for readers with reading
  difficulties).
- Compound nouns closed (`sähköpostiosoite`). Inflect the product's nouns rather than quoting them
  ("OpenAI:n API-avain", "spec.json-tiedoston").
- Prefer a Finnish word where one exists (`yleiskatsaus`, `tuotettu` or `luotu`, `mallivalinnat`);
  never `sessio`, never `generoitu`.
- Avoid stacked -ksesi/-kseen forms ("antaaksesi suostumuksen ja aloittaaksesi"): split into
  clauses.
- Numbers Finnish style: `0,017`, `5 Mt`, dates `13.10.2026`, an en dash with spaces for ranges.
- Buttons, tiles and column headers have a character budget (30 and 28) because Finnish runs long;
  `apps/web/test/copy-length.test.ts` keeps them there.

## Adding or changing a string

1. Add it to `en.ts`, then `fi.ts` (tsc fails until both exist). Use a function for anything that
   interpolates; do not concatenate pieces in a component.
2. Check the glossary. A new concept gets a glossary row first.
3. For an identifier from the API or a shared enum, add it to `t.enums` and to the kind's registry in
   `lib/i18n/enums.ts`; do not map it in the component.
4. Apply the three-part rule if it is an error, and name the next step if it is an empty state.
5. Run `pnpm --filter @aidp/web test`: parity, enum, settings, copy-truth and length tests all read
   the locale files.

## Before and after

| Before                                                     | After                                                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Your data was deleted. A confirmation email is on its way. | Your answers were deleted. Your answers, recordings and files are gone.                            |
| Nothing is shared outside your organization.               | Your organization's admins can read them, and the AI services your organization uses process them. |
| Nothing was lost. Try again in a moment.                   | Your answers are saved. Try again in a moment.                                                     |
| The campaign has ended and no longer accepts answers.      | This interview round has ended and no longer takes answers.                                        |
| Answer is streaming                                        | The interviewer is answering                                                                       |
| Every knob from the specification, grouped by category.    | Everything you can adjust, grouped by category.                                                    |
| Routing per purpose                                        | Model assignment per task                                                                          |
| No sessions yet.                                           | No interviews yet. They appear here as soon as someone opens the link.                             |
| fi: Haastattelija vastusti kerran                          | fi: Haastattelija esitti vastaväitteen kerran                                                      |
| fi: Kojelauta                                              | fi: Yleiskatsaus                                                                                   |
