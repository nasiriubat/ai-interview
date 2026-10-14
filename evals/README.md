# Evals

Fixed transcripts and checks that run in CI on every change (NFR-06). Two kinds:

- **Deterministic** (`src/*.eval.ts`, `src/*.test.ts`, run by `pnpm test`): replay scripted interviews
  through the real engine with a scripted model. No network, no keys. These guard the engine's
  logic, and since D-192 the capture of requirements: how much of what a participant said is still
  in the recorded specification after the turn contract, validation and repair.
- **Model-backed** (`live/*.live.ts`, run by hand, never by CI): the same engine against configured
  providers. They cost real tokens.

## The replay fixtures and the gate

`fixtures/<templateKey>/<persona>.json`: six personas (cooperative, terse, off topic, contradictory,
technical, nontechnical) for each of `requirements_discovery` and `opportunity_discovery`. Each is 60
participant turns with gold labels (`src/fixture.ts` is the schema; a file that does not parse fails
the run):

- `goldRequirements`, `goldFacts`, `goldFindings`: what a perfect capture would hold;
- `turns[].labels`: which requirement, fact or note each turn introduces;
- `modelBehavior.flaws`: where the recorded model breaks its reply (a missing marker, malformed or
  truncated JSON, a requirement filed under `rules`, a descriptive id, a pile of rules, nothing
  captured), and `modelBehavior.scans`: what each issue-detection pass returns.

`src/gate.eval.ts` replays every fixture (engine, extraction and rolling summary, `src/replay.ts` and
the recorded model in `src/replay-model.ts`), computes the metrics of `src/metrics.ts` (coverage
progression, fact recall after the rolling summary, requirement capture, FR-id integrity, spec
completeness, issue precision and recall, turn-contract rates; each is unit tested in
`src/metrics.test.ts`) and compares them with `baselines/replay.json`: exact metrics must match,
ratio metrics may not fall (failure rates may not rise) by more than 0.02. An improvement does not
fail, but the baseline is raised in the same change so the diff is visible in review:

    pnpm --filter @aidp/evals eval:baseline     # rewrites baselines/replay.json
    pnpm --filter @aidp/evals eval:fixtures     # regenerates the fixtures from tools/gen-fixtures.ts

`EVAL_INSPECT=<fixture id> pnpm --filter @aidp/evals exec vitest run src/inspect.eval.ts` prints what
a replay recorded, for authoring a fixture or reading a gate failure.

The model side is scripted from the labels, so the fixtures cannot say whether a prompt works; they
say whether the engine keeps what a model gave it. Prompt quality is what the live checks are for.

## `live/variance.live.ts`

Runs the requirements interview N times (default 5, hard cost cap 1.5 USD) with the shipped
nontechnical owner persona of `scripts/live-run` as the simulated participant, the real engine,
extraction, rolling summary and spec generation, and reports the distribution of recorded and
generated requirements (min, median, max), the parse-failure rate of the turn contract and what each
run cost. See the header of the file for the environment variables. The key is read at runtime from
`OPENROUTER_API_KEY` or the first `.env` above the repository and is never printed. Results are
recorded in `docs/team/live-run-2026-10-14.md`.

`LIVE_SAVE_DIR=<dir>` keeps every interview's transcript, recorded facts and generated requirements
(`<persona>-<n>.json`); `LIVE_PERSONA=technical` runs the engineer owner; `LIVE_FINISH_AT=<turn>`
has the owner press "I'm done" at that turn, as in the product, so the requirements confirmation
runs. `LIVE_DISAGREE=1` (with `LIVE_FINISH_AT`) makes the owner answer the read-back by editing item 1,
removing item 2 and adding a requirement; the run prints and saves whether the generated specification
reflects each (`readBack` in the artifact).

`src/readback-corrections.eval.ts` is the deterministic half: the same three corrections through the
real engine with a scripted model (that the facts are applied, the finding settled and the document
changed), and the interview that is left during the read-back (the document says the list was never
reviewed, D-290).

## Specification quality (`live/spec-quality.live.ts`, `live/spec-replay.live.ts`)

Counting requirements cannot see whether they are right. `spec-quality.live.ts` takes a directory
of saved interviews and has a cheap model judge each requirement against the participant's own
words: grounded (with a quote that code verifies is verbatim), atomic or a detail, a capability or
a decision, testable, scope not contradicted, and which ones repeat another (one grouping call per
specification). It also lists the features the participant asked for and which of them no
requirement covers. The deterministic half, the verification of the judge's output and the
aggregation into rates, is `src/spec-quality.ts` and is unit tested; `SQ_LABELS` compares the judge
with a hand-labelled file and prints agreement and Cohen's kappa. `spec-replay.live.ts` runs the
current generation code over the recorded facts of saved interviews, so before and after are
measured on the same transcripts. Both have cost caps; see `docs/team/spec-quality-2026-10.md`
for the measurement and the judge's validation.

`live/scale.live.ts` checks clustering at 500 facts (see its header).
