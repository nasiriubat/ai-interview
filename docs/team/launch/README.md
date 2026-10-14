# Proof points kit

Seven artefacts that back the landing page's claims. Each is generated from the product; nothing is
mocked. Written for the owner, who is also the operator, and for anyone producing a sales pack.

Two rules for every number you publish from this kit:

1. **Say what it was measured on.** The figures we have today come from a harness with simulated
   interviewees and low-cost models. They are _test figures_, not production figures and not a
   price. Production figures come from a pilot (section 8).
2. **Do not claim what the claims inventory does not list as Built.** See
   [claims-2026-10.md](../claims-2026-10.md); the "Say it this way" column is the approved
   wording.

Commands run from the repository root. `<token>` is a staff session JWT (the web app's
`authjs.session-token` cookie value, sent as `Authorization: Bearer <token>`); `$API` is the API
origin, `http://127.0.0.1:4000` in development. All paths are under `/api/v1`.

## 1. A sample anonymised discovery report

What it shows: the report cover (method, what it does not do, reproducibility), the k rule in
action, and "no change recommended" entries.

**From the harness (simulated employees, no real people, so anonymised by construction):**

```sh
# Needs Docker Postgres (container ai-interview-postgres-1, override with LIVE_PG_CONTAINER) and an
# OpenRouter key in OPENROUTER_API_KEY or in an .env found above the repository (LIVE_ENV_FILE).
# Costs real money: about 0.70 USD and about 45 minutes. Cap with LIVE_TOTAL_CAP_CENTS (default 380).
pnpm live:run
# Fewer personas, faster and cheaper:
LIVE_PERSONAS=<id>,<id> LIVE_SKIP_TECHNICAL=1 pnpm live:run
```

Outputs land in `scripts/live-run/out/` (git-ignored): `report.md` (the discovery report),
`transcripts/<persona>.md`, `scorecard.md` (checks, spend, latencies), `spec-*-v1.md` and
`bundle-*/`.

**From a real campaign (the proof that matters):** run a campaign with at least five completers
and `participation: participant_choice`, then either press "Download Markdown" on the report page
or:

```sh
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/analyses/<analysisId>" | jq -r '.report.markdown' > report.md
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/analyses/<analysisId>/report.pdf" -o report.pdf
```

Before publishing: replace the campaign name, keep the cover and the "Where AI is not the answer"
section, and check the Opportunities section for quotes that name a team small enough to be
recognised (k-gating hides quotes below k, but k is a setting; check yours). The cover is English
whatever the interview language (known limit, claims doc finding 2).

## 2. A sample specification bundle

```sh
# From the harness: spec-<owner>-v1.md and bundle-<owner>/ (AGENTS.md, PLAN.md, tasks/phase-N.md,
# spec.md, spec.json, CLAUDE.md) in scripts/live-run/out/ after `pnpm live:run`.

# From a real requirements session:
curl -s -H "Authorization: Bearer <token>" \
  "$API/api/v1/requirements/<id>/versions/<n>/export?format=bundle" -o bundle.zip
curl -s -H "Authorization: Bearer <token>" \
  "$API/api/v1/requirements/<id>/versions/<n>/export.pdf" -o spec.pdf
# What changed between two versions:
curl -s -H "Authorization: Bearer <token>" \
  "$API/api/v1/requirements/<id>/versions/<n>/diff/<other>" | jq
```

To show that the bundle is buildable, let Claude Code build from it and record the commit list with
requirement ids in the messages (FR-1, FR-2, ...). Publish the file tree, `PLAN.md`, one
`tasks/phase-1.md` and the version diff after a reopened session. Do not mention GitHub push until
one has run against a real repository (claims doc, C6).

## 3. Cost per interview

```sh
# Spend grouped by task, campaign, model, provider or day; cents.
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/spend?groupBy=purpose"  | jq
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/spend?groupBy=campaign" | jq
# Completed interviews, to divide by.
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/stats/participation?campaignId=<id>" | jq '.funnel.completed'
# The month's frozen statement, JSON or CSV.
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/spend/statements/2026-10?format=csv"
```

Cost per interview = the campaign's spend on `interview_turn`, `extraction` and `resume_summary`
divided by completed interviews; add the analysis purposes (`clustering`, `analysis_report`)
divided by the same count for the amortised figure. `estimatedCents` and the dashboard's
`estimatedCostShare` say how much of a figure is our estimate rather than the provider's report;
voice rows are the main source. Quote a text-interview figure first.

## 4. Time to report

| Number                                   | Where                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Median interview time (idle gaps capped) | `GET /stats/participation` → `medianActiveSeconds` and `medianSessions`                                  |
| Campaign open to threshold reached       | Campaign `createdAt` (or first session `startedAt`) to the `campaign.threshold` notification's timestamp |
| Analysis duration                        | `GET /analyses/<id>` → `startedAt` to `finishedAt`                                                       |

Present as "N interviews, X minutes of participant time in total, report Y minutes after the Nth
completion", and say how many people it was measured on. The harness's analysis of 500 facts took 49
seconds (below).

## 5. Per-turn reasons: replay evidence for "no leading questions"

```sh
# One interview's event log: every turn with its recorded reason, the area, the coverage change.
curl -s -H "Authorization: Bearer <token>" "$API/api/v1/sessions/<sessionId>/events" | jq
```

In the admin, the same is the interview page's "Event log". Pick an interview, export the log, and
annotate three turns: why this question, what area it moved, what it did not ask. The
deterministic replays that guard the engine run in CI: `pnpm --filter @aidp/evals test`
(`evals/README.md`, six personas per template, 60 turns each). Say "replayed in CI with a scripted
model"; they check that the engine keeps what a model gave it, not that a prompt works.

## 6. Isolation and privacy evidence

| Point at                                                   | What it shows                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/db/test/rls-conformance.integration.test.ts`     | Every tenant table has a policy; cross-tenant reads return nothing              |
| `docs/OPERATIONS.md` (`rls.preflight_failed`)              | The API refuses to start if a table lacks its policy                            |
| `packages/core/test/erasure.integration.test.ts`           | After deletion, no text or JSON column in the database holds the person's words |
| `packages/core/src/privacy/inventory.ts`                   | Per table: what the participant's export contains and what erasure does         |
| `apps/api/test/anonymity.e2e.test.ts`                      | Salted hash, no pointer from answers, day-wide timestamps                       |
| `packages/ai/test/analysis/k-anonymity.test.ts`            | Nothing below k reaches a report                                                |
| `docs/SUBPROCESSORS.md`, `docs/PRIVACY-PROCESSING.md`      | Generated by `pnpm docs:privacy`; drafts for counsel                            |
| `packages/shared/src/settings.ts` (`DEFAULT_CONSENT_TEXT`) | The consent text a participant sees by default                                  |

Regenerate the privacy documents with `pnpm docs:privacy`. Run the database suites with
`DATABASE_URL` set (`pnpm check`). Do not publish this as "audited": no external test has been
done (claims doc, F8).

## 7. The numbers we have

All from `docs/team/live-run-2026-10-14.md`. **Test figures: eight simulated interviewees from the
harness's personas, cheap models on OpenRouter, a development database. Not production figures, not
a price, not a benchmark of any model.**

| Measure                                                   | Value                                                                | Source / conditions                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cost per interview (model usage, ledger)                  | 1.4 to 2.2 cents                                                     | First runs; `interview_turn` on haiku-5.5 at 0.10 / 0.50 USD per Mtok, extraction on mistral-small-3.2                                                                      |
| Ledger for a whole run (8 interviews, analysis, report)   | 40.3 to 41.1 cents                                                   | Re-runs on the pipeline branch; 0.50 USD on the key including failed attempts                                                                                               |
| Interview length                                          | 20 to 24 turns                                                       | Eight interviews ended through the engine                                                                                                                                   |
| Facts per interview                                       | 5 to 44                                                              | Same                                                                                                                                                                        |
| First token, interview turn, p50                          | 2.7 s (discovery), 3.9 s (requirements)                              | Same                                                                                                                                                                        |
| 500-fact campaign clustered and reported                  | 49 s, 6.6 cents, 50 model calls, 46 clusters, 40 opportunities       | `evals/live/scale.live.ts`, gpt-4.1-mini; copies of the same facts, so it shows that the pass completes and stays bounded, not that clusters at 500 distinct facts are good |
| Requirements captured per requirements interview (5 runs) | 25 / 32 / 45 (min / median / max), 0 of 240 turns without a contract | `evals/live/variance.live.ts`. Quality of those requirements has not been judged; the median is probably too high                                                           |
| Run cost of the whole live harness                        | about 0.70 USD, about 45 minutes                                     | `pnpm live:run`                                                                                                                                                             |

The landing page uses only the first and the interview-length rows, each labelled as an internal
test. Re-run `pnpm live:run` on the current tip before quoting any of this externally: the rows
predate the spec-quality work in progress.

## 8. What a pilot must add

A pilot is where the figures stop being test figures:

1. Run a real campaign with at least five completers, in `participant_choice` mode, for sections 1,
   3, 4 and 5.
2. Run one real requirements interview on a small idea (the landing page itself is a good
   candidate) and build from the bundle, for section 2.
3. Record one real GitHub push, so the claim can move from Partial to Built.
4. Interview in Finnish at least once, so the interface claim can be joined by an interview claim.
5. Update [claims-2026-10.md](../claims-2026-10.md) in the same change that publishes a number.
