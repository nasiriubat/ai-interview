# live-run: the pipeline against a real model

A harness that runs the whole product once, end to end, with real models and simulated people, and
writes a scorecard. It is the only place the pipeline is checked against a model that can surprise
it. **It costs real money** (about 0.5 to 3 USD a run, hard-capped, see below) and is never part of
`pnpm check`.

The findings of the first run are in `docs/team/live-run-2026-10-14.md`; the model-backed evals in
`evals/live/` reuse this harness's simulator, judge and runtime helpers.

## What it does

1. Starts its own stack: a fresh database (`ai_discovery_live`, dropped and recreated each run) on the
   development Postgres container, migrations, bootstrap, then the API and the worker as child
   processes on port 4100.
2. Points the platform at OpenRouter through the product's own provider and route settings, picking
   low-cost models by price and capability, and sets a tenant budget through the budget feature.
3. Creates a campaign and runs simulated employees (`src/personas.ts`) through discovery
   interviews, including the "I am done, delete my data" probe.
4. Waits for extraction, judges the transcripts, runs the collective analysis and reads the report.
5. Promotes an opportunity into a requirements session, runs a nontechnical and a technical owner
   interview, generates a specification version, exports the bundle, makes a second version and
   diffs them.
6. Checks invariants (no participant names in the report, k-anonymity, all report sections, bundle
   files, database integrity) and writes `out/scorecard.md`.

## Running it

```bash
pnpm db:up                 # the development Postgres container must be running
pnpm build                 # the harness starts the built API and worker
export OPENROUTER_API_KEY=...   # or keep it in an untracked .env, see "The key"
pnpm live:run
```

Concurrent runs: set `LIVE_RUN_ID=<name>` (lowercase letters, digits, underscore, up to 24) and the
database (`ai_discovery_live_<name>`), the API port (derived from the id, 4101 to 4199), the scratch
directory and the output folder (`out/<name>/`) all carry it, so runs do not touch each other. Without
an id the historical names are used (`ai_discovery_live`, 4100, `out/`) and a lock file in the
system temp directory refuses a second run with a message naming the other process (a lock whose
process is dead is taken over). `LIVE_DB_NAME`, `LIVE_API_PORT` and `LIVE_RUN_SCRATCH` still override
single names. The model-backed evals that read a run's database take `LIVE_DB_NAME`.

Everything it writes goes to `scripts/live-run/out/` (git-ignored): transcripts, `report.md`, the
specification versions and bundles, `scorecard.md`. Child-process logs go to a scratch directory
outside the repository.

### The key

`OPENROUTER_API_KEY` is read from the environment, or from `LIVE_ENV_FILE`, or from the first
`.env` (the root file) or, for installs that have not migrated, `apps/api/.env` found walking up from the worktree. It is held in memory, registered for
redaction, and handed to child processes through their environment. It is never written to
`out/`, a log or a command line. Do not paste it into an issue or a transcript.

### Settings (environment)

| Variable                      | Default                            | Meaning                                                 |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------- |
| `LIVE_TOTAL_CAP_CENTS`        | `380`                              | Everything the run may spend, ledger plus harness calls |
| `LIVE_TENANT_BUDGET_CENTS`    | `400`                              | The tenant budget the product itself enforces           |
| `LIVE_PERSONAS`               | all                                | Comma separated persona ids to run                      |
| `LIVE_SKIP_TECHNICAL`         | off (`1` to skip)                  | Skip the technical owner requirements interview         |
| `LIVE_CONCURRENCY`            | `3`                                | Interviews at a time                                    |
| `LIVE_MAX_INTERVIEW_TURNS`    | `60`                               | Safety stop for one interview                           |
| `LIVE_MAX_REQUIREMENTS_TURNS` | `60`                               | Safety stop for one requirements interview              |
| `LIVE_CAMPAIGN_MAX_TURNS`     | `18`                               | The campaign's own turn cap                             |
| `LIVE_MODEL_SIMULATOR`        | `qwen/qwen3-30b-a3b-instruct-2507` | Model that plays the employee                           |
| `LIVE_MODEL_JUDGE`            | `openai/gpt-4.1-mini`              | Model that judges transcripts                           |
| `LIVE_RUN_ID`                 | none (`default`)                   | Isolates database, port, scratch and `out/` per run     |
| `LIVE_API_PORT`               | `4100`                             | Port of the API it starts                               |
| `LIVE_DB_NAME`                | `ai_discovery_live`                | Database it drops and recreates                         |
| `LIVE_PG_CONTAINER`           | `ai-interview-postgres-1`          | Postgres container it runs `psql` in                    |
| `LIVE_RUN_SCRATCH`            | system temp directory              | Child-process logs                                      |
| `LIVE_ENV_FILE`               | none                               | A specific env file to read the key from                |

### Spending

A watcher polls the ledger every 15 seconds. When the ledger passes the tenant budget, or ledger
plus the harness's own calls passes the total cap, it sets an abort reason and every loop stops
between turns. The tenant budget is also enforced by the product, which is part of what the run
checks. Reasoning-capable models are avoided on purpose: they spend hidden output tokens and were
cut off mid-answer in the first run.

## Reading the result

`out/scorecard.md` lists, per interview: turns, whether the engine ended it, areas covered, facts,
cost, first-token latency, the judge's verdict and the heuristic flags (several questions in one
turn, leading questions, asking where AI should go). It then lists the spec checks, the analysis
checks and database integrity. A flagged item is a lead to read the transcript, not a verdict: the
judge is a model (see `evals/` for how its labels are validated).

## What it does not do

- It does not touch your development database: it uses its own, which it drops.
- It does not run in CI. For the deterministic engine replays use `pnpm --filter @aidp/evals test`.
- It does not measure latency under load or with people; see `load/` and `docs/DEPLOY.md`.
- Simulated employees are cooperative language models. Real people are shorter, vaguer and
  inconsistent, so the numbers here are a floor for difficulty, not a forecast.

## Tests

`pnpm --filter @aidp/live-run test` runs the pure parts (scoring, redaction, checks) with no
network and no model.
