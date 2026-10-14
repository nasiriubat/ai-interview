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

## Second pass (D-290 to D-294)

The follow-ups D-249 listed: a grouped merge pass, the read-back eval, regenerating the fresh
interviews with the final code and judging all six. Data: `evals/measurements/2026-10/`
(`replay-grouped/` the six original transcripts through the grouped pass, `after-grouped/` six fresh
interviews of the final code, `readback/` the disagreeing-owner run). Same judge, same cheap models.

### What changed

| Where                                    | Change                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirement_merge@2`, `spec/merge.ts`   | Grouped, component-wise: candidate pairs are joined into clusters and the model returns groups of ids that are one capability, instead of a verdict per pair. Cluster of at most 30, call of at most 60 requirements, 6 calls. The pairwise `@1` is retired in the pin file |
| `curateForGeneration`                    | Two rounds: overlap 0.25, then every pair when 8 or more requirements are left, so a restatement in different words is seen. Pairs a round judged different are not offered again                                                                                           |
| `selection.ts`, `issues.ts`              | The read-back is raised on finish or near the cap whatever else is open, and is the focus before the closing question. This was a defect, see below                                                                                                                         |
| `generateSpec`                           | `readBack: confirmed / unanswered / never`; unless confirmed, one open question says the list was not reviewed (the D-249 leaving-the-interview limit, deterministically)                                                                                                   |
| `evals/src/readback-corrections.eval.ts` | Gate tests: an edit, a withdrawal and an addition through engine, curation and generation; finish with areas open reads the list first; leaving during the read-back marks the document                                                                                     |
| `live/variance.live.ts`                  | `LIVE_DISAGREE=1`: the owner answers the read-back by editing item 1, removing item 2 and adding one, and the run checks the specification                                                                                                                                  |

### A defect the measurement found

The read-back of D-244 did not happen on interviews the owner ends with "I'm done", which is the
case it was written for. `chooseFocus` sent `finishRequested` straight to the closing question, and
`shouldScanIssues` did not raise the confirmation while any finding was open. Counting the numbered
list in the saved transcripts: 2 of 12 earlier interviews (`after/`, and the first grouped run) were
read their list at all. The "6 of 6 ended through the engine" row above is true and says nothing
about confirmation. With the fix, 6 of 6 fresh interviews were read the list.

### Before and after

"Replay" is the six original transcripts and facts through the generation code. "Fresh" is six new
interviews (3 + 3, 40 turns, then "done"), judged with the same judge.

|                                           | Before (6)      | Replay, pairwise (D-241) | Replay, grouped (D-290) | Fresh, final code (6) |
| ----------------------------------------- | --------------- | ------------------------ | ----------------------- | --------------------- |
| Requirements judged                       | 159             | 104                      | 96                      | 44                    |
| Median per specification                  | 17 to 28        | 12 to 18                 | 11 to 17                | 7                     |
| Duplicate (judge)                         | 37%             | 18%                      | 16%                     | 11% (nt 17%, tech 5%) |
| Grounded, quote verified                  | 81%             | 86%                      | 90%                     | 93%                   |
| Grounded, as claimed                      | 90%             | 94%                      | 94%                     | 96%                   |
| Over-granular                             | 14%             | 10%                      | 12%                     | 2%                    |
| Non-requirement                           | 9%              | 1%                       | 4%                      | 5%                    |
| Testable acceptance                       | 96%             | 95%                      | 98%                     | 93%                   |
| Stated capabilities no requirement covers | 43 of 118 (36%) | 40 of 119 (34%)          | 43 of 120 (36%)         | 45 of 116 (39%)       |
| Read back to the owner                    | 0 of 6          |                          |                         | 6 of 6                |

Two intermediate grouped replays are not in the table: the pairwise-shaped candidate set gave 23%
duplicates, the whole-list second round gave 16%. Each replay is a single sample of a model that is
not deterministic (one transcript produced 30, 27 and 26 requirements on three runs).

### Against the targets

| Target                             | Result                                                                                                                                                                                             | Reached                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Duplicates under 5%                | 11% on the final six by the judge; 16% in the grouped replay. By my reading of the 44, about 2 are real, the rest are the judge's false positives (a UI detail called a duplicate of a capability) | Not by the judge. Possibly by hand reading, which is 44 items and a single reader, so not claimed |
| Verified grounding at least 90%    | 93% fresh, 90% replay                                                                                                                                                                              | Yes, on 44 requirements                                                                           |
| Without losing stated requirements | Uncovered capabilities 36% to 39%; the interviews recorded 5 to 20 requirements where the earlier ones recorded 24 to 40; median 7                                                                 | Not shown. The fresh interviews capture less and the judge cannot say that nothing was lost       |
| Median ward-notes persona 8 to 20  | 7 (nontechnical), 7 (technical)                                                                                                                                                                    | No, one below the range                                                                           |

### Read-back with a disagreeing owner

Deterministic (gate, 3 tests): an edit under the same FR id replaces the title; a requirement
re-recorded with `withdrawn: true` is absent from the document and the Markdown; an added
requirement is a new FR; the confirmation finding is settled; finish with areas open reads the list
before closing; an interview left during the read-back produces `readBack: unanswered` and the open
question.

Live, one run (the owner edits item 1, removes item 2, adds a photo attachment): the specification
showed all three and `readBack` was `confirmed`. The edit check is a keyword match, the run is one
interview, and a first attempt hit the same defect as above and a second a provider timeout, so this
shows the path can work with a real model, not how often it does. What it still does not cover: an
owner who disagrees with scope tags or with the order, and a reply the model records under the wrong FR.

### Cost of this pass

About 1.9 USD of the 2.0: replays 0.21, judges of the replays 0.26, fresh interviews 0.95 (two
sets of six, the first discarded when the read-back defect was found), judge of the fresh interviews
0.17, disagreeing-owner runs 0.3. The caps held.

### Not done

- The fresh interviews record fewer requirements than the earlier ones and the judge does not show
  it as loss, but it does not show it as not loss either; a person comparing the transcripts to the
  lists is the check this needs.
- Duplicates in the judge's reading are not under 5%; the judge has false positives here (kappa 0.79
  was measured on the earlier lists) and its number should be read as an upper bound for this set.
- The scope-tag and ordering corrections of the read-back are untested (closed in the fourth pass below).

## Third pass: is anything lost? (D-300 to D-305)

The second pass could not tell loss from padding. `docs/team/recall-2026-10-14.md` measures it with
an independent extraction of what the owner stated, quotes verified in code, and coverage decided by
words first: final FR list recall 62% on the original lists and 85% to 87% on fresh interviews,
anywhere in the specification 91% and 95% to 96%, and only 26% of the original requirements
supported by something the owner said against 98% to 100% now. The earlier lists were padded; the
median of 7 to 8 is not a loss. The "39% uncovered" of D-294 was the judge model's own list and
coverage, checked nowhere. Merging does drop a title in a few percent of merges, which is guarded
(D-301), and the 8 to 20 target is withdrawn (D-303). The live re-run found duplicated requirement
ids in a finished specification, fixed in D-302.

## Fourth pass: the final merge code on the six fresh interviews (D-334, D-335)

The six fresh interviews (`evals/measurements/2026-10/after-d301/`, recorded facts and transcripts)
were generated again through the code as it is on the branch: curation, `requirement_merge@3`, the
D-302 id guard. Judge: the committed `evals/live/spec-quality.live.ts` (gpt-4.1-mini, clustering by
gpt-4.1), calls cached where the prompt was identical, the rest paid for: 0.05 USD for the replay and
0.06 USD for the judge. Artifacts: `evals/measurements/2026-10/final-merge3/`.

| Final code, six fresh interviews | Specs | Requirements | Median | Grounded (verified) | Duplicate (judge) | Over-granular | Non-requirement | Testable | Scope not contradicted |
| -------------------------------- | ----- | ------------ | ------ | ------------------- | ----------------- | ------------- | --------------- | -------- | ---------------------- |
| Nontechnical                     | 3     | 30           | 11     | 90%                 | 30%               | 13%           | 0%              | 90%      | 100%                   |
| Technical                        | 3     | 21           | 6      | 86%                 | 14%               | 14%           | 14%             | 91%      | 100%                   |
| All                              | 6     | 51           | 8      | 88%                 | 24%               | 14%           | 6%              | 90%      | 100%                   |

Recorded to final per interview: 12 to 11, 11 to 6, 14 to 13, 5 to 5, 22 to 6, 20 to 10.

### The 13 requirements the judge called duplicates, labelled by hand

One reader (the agent that ran this, not a person who owns the product), reading title and
acceptance criteria next to the requirement each was said to repeat.

| Interview      | Requirement                                              | Of                                 | Hand label      | Why                                                  |
| -------------- | -------------------------------------------------------- | ---------------------------------- | --------------- | ---------------------------------------------------- |
| nontechnical-1 | FR-8 night nurse sees all notes in one place             | FR-4 autosave                      | Not a duplicate | Different capability                                 |
| nontechnical-1 | FR-9 one Save and Send                                   | FR-3 time defaults to now          | Not a duplicate | Different capability                                 |
| nontechnical-2 | FR-9 name and ID appear within two seconds               | FR-3 save once to both systems     | Not a duplicate | Different capability                                 |
| nontechnical-3 | FR-2 enter once, saved to CareCom and printed            | FR-1 enter once, reaches both      | Duplicate       | Same capability, same actor                          |
| nontechnical-3 | FR-5 patient list with bed and last note time            | FR-3 pick a patient from the list  | Duplicate       | Same list                                            |
| nontechnical-3 | FR-6 blank note with time filled in (and a history view) | FR-4 clean text box with timestamp | Duplicate       | Same screen; the history criteria are extra          |
| nontechnical-3 | FR-7 type a note and hit Save and Print                  | FR-1                               | Duplicate       | The same action                                      |
| nontechnical-3 | FR-8 send to CareCom and print a copy                    | FR-4 (Save and Print)              | Duplicate       | Restates FR-1, FR-2 and FR-4                         |
| nontechnical-3 | FR-14 told it is saved even when print fails             | FR-3 patient list                  | Not a duplicate | The judge named the wrong twin; this is a constraint |
| technical-3    | FR-20 green Received badge within 30 s                   | FR-3 green Received badge          | Duplicate       | Same badge, written as a test                        |
| technical-3    | FR-22 load test passes when 48 of 50 show the badge      | FR-3                               | Not a duplicate | A test criterion, not a capability                   |
| technical-3    | FR-23 load test rolls back at 3 failures                 | FR-3                               | Not a duplicate | A test criterion, not a capability                   |

Both numbers: **24% by the judge (13 of 51), 12% by hand (6 of 51).** The target of under 5% is not
reached under either reading. Five of the six real duplicates are in one interview
(nontechnical-3: 13 requirements, no merge at all, because the grouped pass found no group in it).
The three "not a duplicate" load-test and failure-message items are a different defect the judge
also scores: constraints written as requirements (technical-3, 2 of 10).

What this does and does not show. It is one sample of six, a non-deterministic pipeline and a judge
with false positives (here 7 of 13), read by one person. The 11% of the previous pass was another
sample of the same interviews and is not comparable. `requirement_merge@3` leaves a pair apart when
it is unsure (D-301), which trades duplicates for losses by design; what the replay shows is that on
interviews where the candidate pairs are many and loosely worded the pass can find nothing
(nontechnical-3). Technical-2 went from 22 recorded to 6, an aggressive merge the judge did not
flag as loss; its recall was not re-measured here.

### Read-back corrections: scope tags and order (D-334)

Four deterministic cases were added to `evals/src/readback-corrections.eval.ts`:

- A scope correction moves an item between MVP and future, whichever tag shape the model used
  (`"mvp"`, `"Future"`, `mvp: false`). **Failed before the fix:** `"Future"` and `"later"` were read
  as MVP.
- Later-style words (`later`, `post-mvp`, `v2`) are future. **Failed before the fix.**
- A correction filed under another spelling of the section keeps one fact per id and the id order.
  Passes: `normalizeSectionKey` already covers the spellings the schema allows.
- Requirements are in id order inside each scope block, FR-10 after FR-9. Passes.

Not covered: an owner move to future of one of two items that curation then merges, without a reason
(the merge keeps MVP); and the model recording a reply under the wrong FR, which only the live read-back can show.
