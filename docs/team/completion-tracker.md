# Completion tracker

The one file to read to see where the program stands. Updated at every merge. The plan behind it
is `docs/team/plan/README.md`; the starting assessment is `docs/team/status-2026-10-13.md`.

**Last updated:** 2026-10-14, M3 merged (five branches); spec-quality agent running; M4 starting.

## Headline numbers

| Measure                                                        | Now      | How it is computed                                                                                                                                                                            |
| -------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program to "A+ production-ready handover" (phases 0 to 5)      | **~68%** | About 42 of about 210 deduplicated engineer-days merged and verified                                                                                                                          |
| Safe to run a first pilot tenant (owner operating, one tenant) | **~88%** | Both live-run defects (clustering at scale, reopen) fixed and confirmed live; remaining: requirement capture varies between runs (1 and 1 vs 6 and 8), full compose stack untested end to end |
| Spec coverage, phases 0 to 4                                   | ~87%     | Was ~85%; resume recap, flags, PDF, cluster edits and prompt admin still open                                                                                                                 |
| Automated tests (all merged, zero skipped)                     | 913+     | `pnpm check` with a database; web alone is now 450                                                                                                                                            |

## Milestones

| Milestone               | Days | State                        | What is in it                                                                                           |
| ----------------------- | ---- | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| M0 Land what exists     | 1    | **Done**                     | Working tree committed, three pre-commit gaps fixed                                                     |
| M1 Pilot-safe           | ~35  | **Done, merged, gate green** | Security, operations, engineering correctness, web truth copy and accessibility                         |
| M2 Trustworthy          | ~55  | **In progress (~12%)**       | Copy pass merged. Architecture, tenancy and privacy running. Security part 2 and data model not started |
| M3 Complete the spec    | ~60  | Not started                  | Product blueprint features, redesign, observability                                                     |
| M4 Evidence and A grade | ~50  | Not started                  | Evals, Playwright, load and chaos, pen test, usability tests, drills                                    |
| M5 Launch               | ~10  | Not started                  | Landing page, proof points, name, phase plan says Done                                                  |

## Grades against the starting point

| Dimension          | Start | Now (estimate) | Target | Evidence for the movement                                                                  |
| ------------------ | ----- | -------------- | ------ | ------------------------------------------------------------------------------------------ |
| Security           | C+    | B              | A      | Guards, rate identity, erasure, SSRF, dependencies, suspension, staff identity merged      |
| Operations         | C+    | B              | A      | Alerting, job admin, heartbeat, timeouts, encrypted backups, rollback scripts merged       |
| Engineering health | B     | B+             | A      | Extraction transaction, retention GC, abort plumbing, honest gate merged; evals still thin |
| Usability          | 6.5-7 | 7.5-8          | 9.5    | Locale fix, contrast, announcer, confirmations, error focus, copy pass merged              |
| Spec coverage      | ~85%  | ~87%           | 100%   | Data model and features in M3                                                              |

## Done (merged on the main branch, verified by `pnpm check` with a database)

- Working tree landed as six commits (build, voice, lists, design system, docs).
- Guards run before body validation; every route declares its access; boot refuses undeclared routes.
- Client address through proxy and Caddy with a hop count; per-address and per-email code caps.
- One definition of erasure for participant delete, delete job and retention sweep; database
  triggers refuse content for deleted sessions; old tokens return 401.
- Egress policy for provider URLs, SMTP and the realtime socket; no upstream error bodies returned.
- Dependency upgrades (Next 16.4, nodemailer 10, fastify, OpenTelemetry); audit gate and Dependabot.
- Body limits at Caddy, proxy and API; staff email unique per tenant; suspension enforced for
  participants, jobs and email.
- Alerting with 14 alert kinds, email and webhook channels; budget alerts reach people; the
  participant string is now true.
- Job administration, dead-letter retry, `expireInSeconds`, health sweep, worker heartbeat, notify sidecar.
- Provider timeouts and bounded retries on both adapters; caller abort plumbed end to end.
- Encrypted offsite-capable backups with health; image tags, `upgrade.sh`, `rollback.sh`; `OPERATIONS.md`.
- Extraction commits facts and state in one transaction; retention garbage-collects orphaned files;
  email is send-once; worker settles jobs individually and shuts down gracefully.
- `pnpm check` cannot pass with skipped suites; tests cannot reach the network.
- Finnish and English copy audited and applied; enum and settings labels translated; participant
  errors say what happened, what to do, what was kept.

## In progress right now

| Work                                                                     | Where                     | Expected result                                               |
| ------------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------- |
| Routes to services, lint-enforced ground rules, file splits, role matrix | Architecture agent        | No route file touches the database; every route x role tested |
| RLS on nine more tables, k-anonymity on evidence, salt, DTOs, headers    | Tenancy and privacy agent | Cross-tenant tests for every table; evidence below k hidden   |
| Live OpenRouter run: 8 simulated employees through to spec bundle        | Live harness agent        | A scorecard, cost per interview, and a list of real bugs      |

## Left, in order

1. **M2 wave 2:** uploads hardening, prompt-injection delimiting and quote verification, user disable
   and delete, participant data export, audit log append-only, key rotation, GDPR package,
   `SettingDef.since` and settings history, feature flag cleanup, skip/return/finish as engine
   operations, per-language consent default.
2. **M3:** notifications, hostility flags surfaced, deletion confirmation email, resume recap,
   prompt administration, cluster merge/split/rename, department comparison, PDF export, dashboard
   statistics, template rollback, per-template voice toggle, editable diagrams, voice metrics,
   self-serve tenant onboarding, tracing and metrics, restore drill automation, ledger completeness,
   tenant statements, the admin redesign pages.
3. **M4:** 60-turn fixtures and metrics, replay gate, model-backed evals, fake model server,
   Playwright journeys with axe, load and chaos runs, CSP, injection fixtures, external pen test,
   the owner's restore and chaos drills, usability tests, acceptance runs.
4. **M5:** landing page in both languages, in-product wording, product name, proof points,
   phase plan marked Done with evidence links.

## Known risks and open items

- Full compose stack has never been run end to end after M1 (scripts are tested against fakes).
- Realtime voice sockets have no deadlines or retries.
- Quote redaction after deletion is exact-match only; analyses are flagged stale instead.
- `branding.primaryColor` has no consumer; the consent default is English-only.
- A cold `pnpm -r build` is order-fragile (db and core depend on each other); `pnpm check` handles it.

## Decisions waiting for the owner

Defaults are being applied; override any of these at any time. Full table in
`docs/team/plan/README.md`: product name, admin vocabulary (applied: campaign), localising the
settings catalog (applied), external pen test budget, counsel review of DPA and consent, security
contact address, live voice in the first pilot (default: behind its flag).

## Log

| Date       | What happened                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-13 | Status review: six parallel reviews; seven discipline plans; master plan written                                                                                                                                                                                                                                                                                                                                                   |
| 2026-10-13 | M0: working tree committed in six commits                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-10-13 | M1: web, engineering, security merged; operations merged by a dedicated agent after 20 conflicts; gate green                                                                                                                                                                                                                                                                                                                       |
| 2026-10-13 | M2 wave 1 launched; copy pass merged (450 web tests)                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-10-14 | Account session limit (reset 02:10) killed the architecture, tenancy and live-run agents mid-work; their committed work (6, 4 and 5 commits) survived in their worktrees; all three resumed at 02:11                                                                                                                                                                                                                               |
| 2026-10-14 | Live OpenRouter run completed: found the "finish interview" sentinel bug (-1), analysis scaling defect, reopen defect; sentinel fixed and merged; findings in `docs/team/live-run-2026-10-14.md`                                                                                                                                                                                                                                   |
| 2026-10-14 | Architecture refactor merged: services, lint fences, three file splits, role matrix of 169 routes, audit-row tests; 214 API tests                                                                                                                                                                                                                                                                                                  |
| 2026-10-14 | Tenancy and privacy merged: RLS on every table with an inverted preflight and a conformance factory per model, k-anonymity on evidence, salted anonymity, role-based transcripts, encrypted provider headers; found that tenant context never reached HTTP handlers (fixed)                                                                                                                                                        |
| 2026-10-14 | M2 wave 2 launched: pipeline quality and scale, uploads/rotation/export/audit, control operations and recap and flags, settings history and notifications and onboarding                                                                                                                                                                                                                                                           |
| 2026-10-14 | M2 wave 2 merged: configuration (history, notifications, rollback, flags, consent, onboarding), controls (skip/return/finish, recap, flags, deletion email, migration policy), security part 2 (uploads, offboarding, export, append-only audit, key rotation, CSP), pipeline (clustering at scale, reopen, ledger, prompts v5, 35 injection fixtures); gate green, nothing skipped                                                |
| 2026-10-14 | M3 launched (5 agents). Results workspace merged: cluster merge/split/rename anchored to fact ids, department comparison under k, not-AI predicate, dashboard statistics with fixture-checked queries; found Postgres LEAST ignores NULL (wrong median in the blueprint SQL)                                                                                                                                                       |
| 2026-10-14 | Session limit killed the other four M3 agents (requirements capture, exports, observability, redesign); resumed at 08:47; one had 92 uncommitted files and was told to commit first                                                                                                                                                                                                                                                |
| 2026-10-14 | Test database hygiene: the retention suites slowed to 2-4 s per test because 237 leftover test tenants accumulated; recreating the database fixed it. Worth a gate-level fix (tenant-scoped sweeps in tests)                                                                                                                                                                                                                       |
| 2026-10-14 | M3 merged in full: requirements capture contract (min 25 vs 0 requirements; parse failures 68 percent to 0), PDF export and editable diagrams, observability (worker tracing, p95, ledger completeness, statements, restore drill, tenant offboarding, ceilings, circuit breaker), prompt administration, campaign lifecycle page, full-screen voice, dark theme, Playwright and axe (50 pages clean). Gate green, nothing skipped |
| 2026-10-14 | Spec-quality agent launched: 25 to 45 requirements per small tool is over-capture; build a judge, dedupe, right-size                                                                                                                                                                                                                                                                                                               |

- 2026-10-14 — Spec quality merged (D-240..249): dedupe, classification, grounding, read-back. Median requirements for the ward-notes persona 28 → 18 (replay). Not reached: duplicates <5% (18% replay), grounded ≥90% verified (86%). Follow-ups in D-249 (grouped merge pass, regenerate fresh interviews, read-back eval). Gate green.

- 2026-10-14 — M5 landing merged (D-270..279): public EN/FI landing at /, claims inventory (70 rows: 48 built, 8 partial, 14 planned), launch proof kit, report cover wording. Gate green; axe clean on 156 e2e checks. Note for security agent: Sonner injects an inline style (CSP report-only event on every page) and /admin/operator/health uses eval; both must be fixed before CSP enforce. Re-run live run on merged tip before quoting figures externally.

- 2026-10-14 — Security M3 merged (D-260..269, migration 0026): CSP enforced, abuse counters, audit reads, CI gitleaks/trivy, HKDF internal auth, 8h staff sessions, 12 probes (5 broke, fixed), 13 findings (11 fixed). Verification matrix 29/35 closed, 5 partial, 1 open (external pen test). Gate green, 2,773 tests. Owner actions O1..O10 in docs/team/security-verification-2026-10.md. Open: two e2e fixtures drifted (/p/r/<token>, /routes).

- 2026-10-14 — Full-stack drill, load and chaos (D-250..259): the production stack run end to end for the first time after M1 to M3 and ten defects fixed that no harness could see (web image did not build, Caddyfile never loaded, session event seq race, every upgrade rolled itself back, every real-sized backup failed verification, restore left the stack down, failed migration took the site down, first-token deadline not enforced for silent providers, sign-in links without the port, limits that did not fit the stated 4 GB host). k6: 40 interviews + 5 voice + 100-open burst, 0 errors, first token p95 532 ms, voice first word p95 1.44 s; 4 GB preset run without a kill. Chaos: 7 of 7. Open: voice first word depends on reply length, killed worker leaves jobs active until expiry, turn lock 90 s after a kill. Records in docs/team/drills/
