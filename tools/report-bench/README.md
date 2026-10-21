# report-bench: a measured score for the analysis report

Runs a fictional company with **planted ground truth** through a real AIScope instance (simulated
employees answer the real interviewer through the public participant API), lets the product
analyse the interviews, and grades the resulting report against what was planted. The output is
a scorecard (JSON and Markdown) with a 0 to 10 overall, nine criteria and the evidence for each,
and a `compare` mode for before/after.

A full run **costs real money** (about 4 to 6 USD with the production routes, estimated before it
starts and hard-capped by `--max-cost`). Re-grading a cached run, `compare` and the tests cost
nothing or cents. It is never part of `pnpm check`; only its unit tests are.

## Quick start

```bash
pnpm db:up                     # the development Postgres container (ai-interview-postgres-1)
pnpm build                     # the local stack runs the built API and worker
# OPENROUTER_API_KEY in the root .env (or the environment)

pnpm --filter @aidp/report-bench bench estimate
pnpm --filter @aidp/report-bench bench run --name baseline --local --fresh --max-cost 8
pnpm --filter @aidp/report-bench bench compare baseline after-change
```

### Local (`--local`)

Creates database `ai_discovery_bench_<name>` on the development Postgres container, migrates it,
bootstraps it with **only** the OpenRouter key (so the routes are the production defaults from
`packages/ai/src/routes/defaults.ts`: interview and extraction on `anthropic/claude-sonnet-5`,
clustering and the report on `anthropic/claude-opus-5`, all via OpenRouter; no embedding route, so
clustering uses word overlap), and starts the built API (port 4290, `--port`) and worker. The
database is **kept** between runs unless `--fresh`; its per-run secrets are in
`runs/<name>/stack.json` (git-ignored, mode 600).

### Before/after a code change (same interviews)

The interviews and their extracted facts stay in the bench database, so the report can be
re-made by the new code without re-simulating (no simulation noise in the comparison):

```bash
pnpm --filter @aidp/report-bench bench run --name baseline --local --fresh --save-as baseline
# ... change the analysis code, then
pnpm build
pnpm --filter @aidp/report-bench bench run --name baseline --local --force-analysis --save-as after
pnpm --filter @aidp/report-bench bench compare baseline after
```

`--force-analysis` starts a new analysis run on the same campaign; transcripts are read from the
cache. A change to extraction needs `--resimulate --fresh` (new interviews, so expect some noise:
compare more than one run before believing a small delta).

### Production (or any running instance)

```bash
pnpm --filter @aidp/report-bench bench run --name prod-1 \
  --base-url https://aiscope.scholarbro.com/api/v1 \
  --staff-token "$BENCH_STAFF_TOKEN" --max-cost 8
```

- The staff token is the Auth.js session JWT of an admin of the tenant to test in. Sign in (on the
  server: `deploy/signin-link.sh you@example.com`, open the link), then copy the value of the
  `__Secure-authjs.session-token` cookie from the browser's developer tools. The API accepts it as
  a bearer token. Pass it via `BENCH_STAFF_TOKEN` rather than the command line where you can. It
  expires with the session; it is never written to disk by the bench.
- Without `--link`, the bench creates and opens a campaign ("Report bench: ..."), `open`
  verification, `participant_choice` participation, the scenario's turn cap. To use a campaign
  you created yourself, pass `--link <shareable url>` and `--campaign-id <id>`; it must use open
  verification.
- Everything is spent in that tenant and counts against its budget. Use a dedicated tenant and
  delete the campaign afterwards.

## Commands and flags

| Command                                    | What it does                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `bench estimate`                           | Prints the cost estimate for the scenario from current OpenRouter prices. Calls no model.            |
| `bench run --name <run> ...`               | Simulate (resumes from cache), wait for extraction, analyse, fetch the report, grade.                |
| `bench grade --name <run>`                 | Re-grades a cached run (`runs/<run>/` or `results/<run>/`). Judge answers are cached: free.          |
| `bench grade --name <run> --report <file>` | Grades another report file (a saved `GET /analyses/:id` or a `report.json`) on the same transcripts. |
| `bench compare <a> <b>`                    | Per-criterion diff of two scorecards (run names, result names or paths to `scorecard.json`).         |

| Flag                             | Default                           | Meaning                                                     |
| -------------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `--scenario <path>`              | `scenarios/kaarna-logistics.json` | Scenario file                                               |
| `--local` / `--fresh` / `--port` | off / off / 4290                  | Local stack; drop and recreate its database; API port       |
| `--base-url`, `--staff-token`    |                                   | Remote instance (API root incl. `/api/v1`) and admin JWT    |
| `--auth-secret`, `--staff-email` |                                   | Alternative: mint the JWT when you hold `AUTH_SECRET`       |
| `--link`, `--campaign-id`        |                                   | Use an existing open campaign                               |
| `--max-cost <usd>`               | 8                                 | Refuses to start above it; aborts between turns when passed |
| `--sim-model`                    | `anthropic/claude-haiku-5.5`      | Model playing the employees                                 |
| `--judge-model`                  | `anthropic/claude-sonnet-5`       | Judge and observation model (temperature 0)                 |
| `--judge-samples`                | 3                                 | Judge answers aggregated (majority mapping, median scores)  |
| `--temperature`, `--seed`        | 0.7, 7                            | Simulator sampling; the seed is per persona and turn        |
| `--personas a,b`                 | all                               | Subset of personas                                          |
| `--concurrency`                  | 3                                 | Interviews at a time                                        |
| `--force-analysis`               | off                               | New analysis run even when one exists                       |
| `--resimulate`                   | off                               | Ignore cached transcripts                                   |
| `--no-judge`                     | off                               | Deterministic criteria only (keyword mapping)               |
| `--save-as <name>`               |                                   | Copy scorecard, report and transcripts to `results/<name>/` |

## The scenario

`scenarios/kaarna-logistics.json`: Kaarna Logistiikka Oy, a fictional road-freight and
warehousing company in Vantaa. Ten employees in three departments (finance and administration,
terminal operations, customer service), each with a role, attitudes, the facts they know, how
talkative they are and details that would identify them. One answers only in Finnish (the
interviewer follows the participant's language).

| Planted item          | Kind       | Planted in                       | Accepted classes               |
| --------------------- | ---------- | -------------------------------- | ------------------------------ |
| invoice_rekeying      | problem    | 5 people, 3 departments          | automation, ai, software       |
| approval_delays       | problem    | 4 people, 3 departments          | process, software, automation  |
| shift_handover_paper  | problem    | 3 (terminal)                     | software, process, automation  |
| shipment_status_calls | problem    | 2 (customer service)             | software, automation, ai       |
| tachograph_compliance | problem    | 1 (niche, below k)               | automation, software           |
| pod_app_works         | works well | 3                                | none ("no change recommended") |
| ai_everything         | distractor | 1 (wants AI everywhere, no pain) | none, or not raised at all     |

The format is validated by `src/scenario.ts` (zod): `problems[]` with `plantedIn` persona ids,
`expectedClasses`, `impact` (0..5) and `keywords` for the deterministic cross-check; `personas[]`
with `facts`, `talkativeness`, `language` and `identifiers`. Add a scenario by adding a file.

## The rubric

Prevalence is measured against what the interviews actually surfaced, not only what was planted:
a temperature-0 observation pass reads each transcript and lists the planted items the
participant really described ("observed"). A problem nobody got to talk about is not held against
the report. The judge (temperature 0, no hidden reasoning, JSON, rubric-anchored, cached by prompt hash;
asked three times and aggregated by majority and median, because a single answer still moves a
point or two between calls) maps every
report item to ground-truth ids; a keyword matcher maps them independently and the scorecard
prints how often the two agree.

| Criterion (weight)              | How it is scored                                                                                                                                                                                                             | Kind                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Recall of planted problems (20) | Found = 1, split across n items = 1 / (1 + 0.25 (n - 1)), merged with another planted problem = 0.5, missed = 0; a one-person problem weighs half                                                                            | mapping + math        |
| Prevalence accuracy (12)        | Per found problem `1 - abs(reported - observed) / observed`; no count = 0                                                                                                                                                    | deterministic         |
| Ranking sensibility (10)        | NDCG of the report's rank order; gain = observed people + impact; works-well, distractor and unplanted items gain 0                                                                                                          | deterministic         |
| Classification (15)             | Solution class in the accepted set; works-well missing from the report = wrong; distractor raised as AI/automation/software = wrong                                                                                          | deterministic         |
| Quote fidelity (10)             | Every quote (each blockquote line, quoted text outside code fences of 4+ words, item quotes) must be verbatim in a participant answer (case and punctuation ignored, `...` allowed); near-verbatim = 0.5; n/a with no quotes | deterministic         |
| No hallucination (13)           | 10 - 3 per major unsupported claim - 2 per unsupported item - 0.5 per minor                                                                                                                                                  | judge                 |
| Anonymity (10)                  | 10 - 3 per participant name, - 2 per identifying detail, - 3 per below-k item exposing roles, departments or quotes, - 1.5 per judge concern                                                                                 | deterministic + judge |
| Actionability of next steps (5) | Judge score with anchors (10 = concrete, owned, sequenced, evidence-based)                                                                                                                                                   | judge                 |
| Executive-summary accuracy (5)  | Judge score with anchors (10 = right top problems, right order and counts, mentions what works)                                                                                                                              | judge                 |

Overall = weighted mean over the criteria that could be measured (n/a criteria drop out).

## Reproducibility and cost

- Transcripts are cached in `runs/<name>/transcripts.json` as soon as each interview ends; a rerun
  resumes. The participant token is never stored.
- The simulator sends a per-persona, per-turn `seed` (honoured by providers that support it) at
  the given temperature; the product's own models are not seeded, so two fresh simulations differ.
  For a clean before/after, re-analyse the same interviews (`--force-analysis`).
- Judge and observation answers are cached by a hash of model and prompt in
  `runs/<name>/judge-cache/`; regrading the same report is free and gives the same score.
- The estimate is printed before anything runs and the run refuses to start above `--max-cost`.
  During the run a watcher adds the harness's own spend to the product ledger for the campaign and
  checks the OpenRouter key's usage; past the cap, every loop stops between turns. The scorecard
  records the measured spend.

## Why the harness calls OpenRouter directly

AGENTS.md rule 2 (no model call outside `ModelCaller`) is about the product. The persona
simulator and the judge are test tooling outside the product, like `tools/live-run`: they must
not go through the product's routes, budgets or ledger, because the thing under test would then
pay for and be able to influence its own grader. Tests never touch the network (rule 5).

## Layout

| Path                | What                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `scenarios/`        | Scenario files                                                          |
| `src/cli.ts`        | Commands                                                                |
| `src/simulate.ts`   | Persona simulator over the public participant API                       |
| `src/staff.ts`      | Campaign, analysis and spend through the staff API                      |
| `src/localstack.ts` | Local instance with production-default OpenRouter routes                |
| `src/grade/`        | Quote matcher, mapping, scoring, judge, scorecard and compare           |
| `results/<name>/`   | Committed scorecards (and the small transcripts and report behind them) |
| `runs/<name>/`      | Working directory of a run (git-ignored)                                |

`pnpm --filter @aidp/report-bench test` runs the deterministic parts on fixtures, with no network.
