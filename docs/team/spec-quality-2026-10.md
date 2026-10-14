# Specification quality, 2026-10

The capture-reliability work (D-190 to D-194) made requirement capture reliable: on cheap models,
0 requirements in a bad interview became 25 to 45 in every one. Nobody had judged what was
captured. This note is the measurement of that, the defect catalogue, the judge built to keep
measuring it, what was changed, and what the numbers say afterwards, including the targets that
were not reached. Decisions are D-240 to D-249 in `docs/discovery/decisions.md`.

Everything here was run on OpenRouter with the cheap models of `docs/team/live-run-2026-10-14.md`
(interviewer `anthropic/claude-haiku-5.5`, extraction and merge `mistral-small-3.2-24b-instruct`,
specification `openai/gpt-4.1-mini`, simulated owner `qwen3-30b-a3b-instruct-2507`). The data is
committed under `evals/measurements/2026-10/` (`before/`, `replay/`, `after/`: transcript, recorded
facts, generated requirements and Markdown, and `judged.json`), so every table below can be
recomputed without a model call by running `live/spec-quality.live.ts` against the directory with a
cap of 0 (the judge's answers are cached by prompt).

## Method

1. **Before.** Six interviews with the shipped personas, three nontechnical (Helena, ward operations
   manager) and three technical (Aki, engineer), 48 interviewer turns each, saved by
   `live/variance.live.ts` (`LIVE_SAVE_DIR`). Their transcripts, facts and generated specs were read:
   all six in full for the catalogue, and 96 requirements of five of them labelled by hand
   (`before/manual-labels.json`) before the judge was run.
2. **Replay.** The recorded facts of the same six interviews were put through the generation code
   as it is now (`live/spec-replay.live.ts`): same transcripts, same facts, new curation, merge pass
   and specification prompt. What this cannot change is the interviewer's own turns.
3. **After.** Six fresh interviews (3 + 3) with the new prompts, 40 turns, and the owner pressing
   "I'm done" at turn 40 as in the product (`LIVE_FINISH_AT`), so the confirmation read-back runs.
4. **Judge.** `live/spec-quality.live.ts`, described below, over all three sets.

## Defect catalogue (before: 6 interviews, 159 requirements)

Counts of the deterministic detectors are over all 159; counts by hand are over the 96 labelled
requirements of five interviews; "judge" is the cheap-model judge over all 159.

| Defect                                                                             | Count                                                                                                                          | Examples                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Duplicate: same capability, same or reworded title                                 | 59 of 159 by the judge (37%); 45 of 96 labelled by hand; 13 plain title repeats by word overlap alone                          | nontechnical-2 has `Confirm note before Epic`, `Nurse review and confirmation of notes before sending to Epic`, `Confirm note saved in Epic`, `Show success confirmation after note saved in Epic`, `Confirm note success`, `Success confirmation details`, `Show success message with note details`, `Help request confirmation`, `Confirm help request was received`, `Confirm help request arrival during sandbox testing`; technical-3 has `Shift summary view` twice (FR-15, FR-16), the PDF handoff export three times (FR-18, FR-19, FR-23), roster drop under 90 seconds four times (FR-31, FR-34, FR-35, FR-37) |
| Near-duplicate worded differently                                                  | most of the 59; 119 candidate pairs above 0.4 word overlap                                                                     | `Navigate to next patient after confirmation` and `Navigate to next patient's note after confirmation`; `Patient status precedence` and `Roster status precedence`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Over-granular: a detail, field, message text or measurement as its own requirement | 23 too fine and 18 "detail" of 159 by the judge; 17 too fine and 8 detail of 96 by hand                                        | `Save confirmation` (toast text), `Blank note start`, `Roster load time` and `Verify roster contents and load time` beside `Patient roster on sign-in`, `Review screen` three times, `Alert status during sync delay`                                                                                                                                                                                                                                                                                                                                                                                                    |
| Non-requirement filed as FR                                                        | 4 decisions and 11 constraints by the judge; 4 constraints by hand                                                             | `Pilot ward pass test criteria`, `Definition of major error`, `Pass test after full shift use` (project acceptance tests); `Automatic dashboard generation` (an implementation of FR-1)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tombstones: a model "deleting" what it can only re-record                          | 4                                                                                                                              | nontechnical-3 FR-2, FR-4, FR-5 are titled `Removed`; technical-2 FR-8 is `Merged into FR-6`. They count toward the requirement total and the minimum                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| FR id drift                                                                        | 4 of 159                                                                                                                       | `pilot-pass-test`, `major-error-definition`, `pass-test`, `roster_membership` in the functional list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Untestable acceptance                                                              | 4 with none, 39 with exactly one check; judge: 6 of 159 not testable                                                           | technical-2 FR-8, nontechnical-3 FR-2/4/5 have an empty acceptance list; `Observation entry form`: "The form has clear fields for each observation"                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Ungrounded or only partly grounded                                                 | judge: 4 not said, 27 partial (12 by its own claim, 15 more because its quote was not verbatim); by hand 3 not said, 9 partial | technical-2 FR-12 `Failed EPR write handling` (nobody said it), FR-2 `Automatic dashboard generation` (the owner deferred the dashboard and never described its generation)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Wrong scope tag                                                                    | judge: 2 contradicted; by hand 1                                                                                               | technical-2 FR-10 `Edit saved note within 15 minutes` is tagged mvp while the owner deferred "note versioning" to v1.1. Only 4 of 159 requirements are tagged future at all                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Missing obvious requirements                                                       | judge: 43 of 118 stated features not covered (36%); noisy                                                                      | nontechnical-2: the owner asked for every access and change to be logged and kept six years (HIPAA); no requirement says so (the CareVue timestamp she asked to keep survives only inside acceptance criteria)                                                                                                                                                                                                                                                                                                                                                                                                           |
| Hallucinated                                                                       | few as such (4 judged not grounded); the larger effect is restatement, not invention                                           | the technical owner's feature creep is the simulator's, not the engine's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### What produced them

Read from the code and from the transcripts, not guessed:

- The interviewer was shown the requirement ids ("functional: FR-1, FR-2, ...") and never their
  titles, and so was the extractor (`spec_field: functional.FR-3`). A model that cannot see what is
  recorded files the same capability again, in new words, every time the participant circles back.
  This is the main cause of the duplicates.
- Extraction filed every extracted spec fact and the capture rules said "every capability is its own
  fact", with no word on what a capability is. A confirmation message and the text of the
  confirmation message are both "capabilities".
- Nothing separated a requirement from a decision or a constraint, and the only way a model could
  withdraw a requirement was to overwrite it with the word "Removed".
- Nothing checked that a requirement rests on anything the participant said.
- The interviews never ended: all six hit the 48-turn cap. The harness did not press "done", and
  with 15 areas the engine rarely closes on its own that early, so the owner was never read the list.

## The judge

`evals/live/spec-quality.live.ts`, with the deterministic half in `evals/src/spec-quality.ts`
(11 unit tests). Per interview:

- one structured call per chunk of 20 requirements (gpt-4.1-mini) against the transcript: grounded
  (yes, partial, no, with a quote), granularity (ok, too fine, too coarse), kind (capability,
  detail, decision, constraint, question), testable, scope tag (correct, wrong only when the owner
  said the opposite, unclear);
- duplicates need the whole list in view, so: one grouping call over all requirements (gpt-4.1) and
  a pairwise check (gpt-4.1) of every pair that shares words above 0.25, the two unioned;
- features the participant asked for (8 to 20 per interview, cached per transcript) and which of
  them no requirement covers.

What code checks so the judge's word is not taken: a grounded "yes" needs a quote that
`quoteIsVerbatim` finds in the participant's own words, otherwise it is "partial"; a duplicate-of
must name another listed requirement; a missing verdict is read as the harshest one. Both the
verified and the as-claimed grounding are reported. Cost cap and a per-call cache are built in.

### Validation against my labels (96 requirements, 5 interviews)

| Dimension                        | Agreement | Cohen's kappa | Judge only | Manual only | Reading                                                                                                                    |
| -------------------------------- | --------- | ------------- | ---------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| duplicate                        | 90%       | 0.79          | 1          | 9           | Good, and conservative: it misses some I call duplicates, it almost never invents one. Its duplicate rate is a lower bound |
| kind (non-capability)            | 94%       | 0.54          | 6          | 0           | Acceptable; it calls more things "constraint" than I did                                                                   |
| grounded                         | 87%       | 0.48          | 4          | 9           | Moderate; a little lenient                                                                                                 |
| testable                         | 96%       | 0.48          | 2          | 2           | High agreement because nearly everything is testable; kappa is mediocre                                                    |
| scope contradicted               | 97%       | -0.01         | 2          | 1           | Not informative: there are almost no contradictions to find, so this dimension is not validated                            |
| granularity (too fine or detail) | 78%       | 0.15          | 8          | 13          | Weak. Do not read the over-granular rate or the too-coarse rate as more than a rough signal                                |

The first judge (per-requirement duplicate flag only) had a duplicate kappa of 0.36 and found 22 of
my 45 (and 7 that I did not call duplicates); the grouping and pairwise passes and a statement that the same title is the same capability
whatever its acceptance list says brought it to 0.79. The judge is a different model family from
the interviewer and the generator, but it is a model: the numbers below are its reading, bounded by
the agreement above.

## Before and after

Same judge, same labels, same caps lists per transcript. "Replay" is the same six transcripts and
facts through the new generation code; "after" is six fresh interviews (only the three
nontechnical ones could be judged inside the budget).

|                                                                 | Before (6 interviews) | Replay (same 6, new generation)       | After, fresh (3 nontechnical judged) |
| --------------------------------------------------------------- | --------------------- | ------------------------------------- | ------------------------------------ |
| Requirements per specification, nontechnical (min, median, max) | 24, 28, 40            | 12, 18, 27                            | 13, 14, 18                           |
| Requirements per specification, technical                       | 12, 17, 38            | 10, 12, 25                            | 9, 10, 12 (not judged)               |
| Requirements judged                                             | 159                   | 104                                   | 45                                   |
| Grounded, quote verified                                        | 81%                   | 86%                                   | 89%                                  |
| Grounded, as the judge claimed                                  | 90%                   | 94%                                   | 91%                                  |
| Duplicate (later copy of an earlier one)                        | 37%                   | 18% (nontechnical 11%, technical 28%) | 29%                                  |
| Over-granular (too fine or detail)                              | 14%                   | 10%                                   | 7%                                   |
| Non-requirement (decision, constraint, question)                | 9%                    | 1%                                    | 4%                                   |
| Testable acceptance                                             | 96%                   | 95%                                   | 96%                                  |
| Scope tag not contradicted                                      | 99%                   | 98%                                   | 100%                                 |
| Stated features not covered (judge)                             | 43 of 118 (36%)       | 40 of 119 (34%)                       | 20 of 60 (33%)                       |
| Tombstones, non-FR ids in the functional list                   | 4, 4                  | 0, 5 (model-added, flagged)           | 0, 1                                 |
| Parse failures of the turn contract                             | 0 of 240 turns        |                                       | 1 of 252                             |
| Interviews that ended through the engine                        | 0 of 6 (turn cap)     |                                       | 6 of 6                               |
| Product cost per interview (cents)                              | 7.5 to 9.6            | specification only, about 1           | 7.3 to 8.4                           |

## Against the targets

| Target                                          | Result                                                                                                             | Reached                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicates under 5%                             | 18% (replay), 29% (fresh, with the merge pass inoperative, see below); the judge under-reports against hand labels | No                                                                                                                                                    |
| Grounded at least 90%                           | 86% verified in the replay, 89% fresh; 94% and 91% as judged                                                       | No on the verified basis, yes on the judge's own claim                                                                                                |
| Median count for the ward-notes persona 8 to 20 | 18 (replay), 14 (fresh)                                                                                            | Yes                                                                                                                                                   |
| No loss of requirements the owner stated        | pooled uncovered features 36% to 34% (replay); nontechnical alone 13 of 59 to 16 of 60 on identical transcripts    | Not shown. Pooled it did not worsen; for the nontechnical persona three more features are uncovered, which the judge's noise cannot be separated from |
| Median technical                                | 12 (replay), 10 (fresh)                                                                                            | Yes                                                                                                                                                   |

### Why the first two are not met, exactly

- **Duplicates.** The deterministic part removes plain repeats (13 of 159). The rest depends on
  candidate pairs by word overlap (0.3 and above) and a verdict from the cheap structured model.
  That model, under a strict schema, first answered with the whole line it was shown as the id
  (so no verdict matched and the pass did nothing), and with the first prompt ("answer different
  when unsure") kept `Show clear error messages on sync failure` apart from `Clear on-screen sync
error messages`. Both are fixed (D-241). The fresh runs started before the id fix, so they only got
  the exact merges; they were not re-generated for lack of budget, so 29% is not the number the
  shipped code gives. The replay is the measurement of the shipped code, and it leaves 18%: part
  of it is the judge calling the pieces of a bundled requirement (technical-3 FR-3 `roster and note
entry`) duplicates of it, part is real (technical-3 FR-34 and FR-35 are one requirement).
- **Grounded.** The code insists on a verbatim quote. The judge's quotes often are not verbatim
  (paraphrase, two turns joined), so 8 points of the gap are quoting, not grounding. The requirement
  rate itself rose with the interviewer's quote rule (D-243), but a requirement the owner confirmed
  with "yes" after a proposal has no sentence of its own to quote.

## What changed

| Where                                  | Change                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interviewer v7 and capture rules       | One requirement per demonstrable capability, details are its acceptance criteria; never a second one for a recorded capability; a verbatim `evidence` quote per requirement; decisions, constraints, questions go elsewhere; observable acceptance; the confirmation read-back |
| Context, extraction                    | The requirement list with titles goes to the interviewer (last 40) and the extractor (last 60, always)                                                                                                                                                                         |
| Extraction v4, repair v3               | The same rules; a twin of a recorded requirement is dropped at filing                                                                                                                                                                                                          |
| `spec/quality.ts`                      | Word-overlap similarity, classification, UI-detail folding, group merge, `mergedFrom`, non-FR renumbering, tombstones                                                                                                                                                          |
| `spec/merge.ts`, `requirement_merge@1` | One cheap call per 24 candidate pairs, at most 6 per specification                                                                                                                                                                                                             |
| `generateSpec`                         | Curates the state before the model sees it; model-added requirements are folded into a twin or flagged; the state's marks survive the model's echo                                                                                                                             |
| Delta validation                       | Reroutes non-capabilities, turns tombstones into withdrawals, marks ungrounded requirements `needsConfirmation`                                                                                                                                                                |
| Finding flow                           | The numbered list is read back once through the existing finding mechanism (D-244)                                                                                                                                                                                             |
| Spec v3                                | No requirements of its own; additions go to open questions                                                                                                                                                                                                                     |

## Findings that were not asked for

1. A cheap model under a strict JSON schema may answer with the whole line it was shown as an id.
   Any pass that matches model-returned ids against a list needs to read the first token
   (fixed here in the merge pass; `settleTurnContract` and the extractor were not seen doing it).
2. The specification model, told in v2 nothing about it, adds requirements under its own ids
   (`roster_membership`); the instruction in v3 is not enough on its own, so the code now folds or
   flags them.
3. The curation was silently discarded by the model's echo of the requirement (the generated one
   replaced the recorded one wholesale). The unit test that would have caught it did not exist.
4. The harness interviews never reached the end: with 15 areas and a 48-turn cap the engine does
   not close by itself. Every earlier "median 32 requirements" was measured on interviews no owner
   would have finished.
5. The simulated owner drifts into features it was never asked about (a first-use tutorial,
   in-system messaging). Some of what looks like over-capture is the persona, not the engine; the
   persona is not corrected here.
6. `once` is a stop word of the similarity (it appears in many titles); "Nurse enters a note once"
   and "Nurse enters a note" are then the same. That is the intended direction but it is a choice.

## Cost

About 1.97 USD in total by the printed spends: baseline interviews 0.62, judge runs 0.37 (five
iterations on the same six specifications), replays 0.21, fresh interviews 0.56, judge of the
replay 0.11, judge of the fresh interviews 0.09 (stopped by its cap after three of six). The cap
held; the last 0.1 of budget could not buy a replay of the fresh interviews with the fixed merge.
