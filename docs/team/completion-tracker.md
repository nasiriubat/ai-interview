# Completion tracker

The one file to read to see where the program stands. Updated at every merge. The plan behind it
is `docs/team/plan/README.md`; the starting assessment is `docs/team/status-2026-10-13.md`.

**Last updated:** 2026-10-14, all agent waves merged (spec quality, landing, security M3, full stack, reliability, recall, demo, demo-defect fixes); nothing running.

## Headline numbers

| Measure                                                        | Now      | How it is computed                                                                                                                                              |
| -------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Program to "A+ production-ready handover" (phases 0 to 5)      | **~68%** | About 42 of about 210 deduplicated engineer-days merged and verified                                                                                            |
| Safe to run a first pilot tenant (owner operating, one tenant) | **~97%** | All seven pilot blockers closed; remaining: full compose stack run end to end (agent running), duplicates still 18% in requirement lists, owner actions O1..O10 |
| Spec coverage, phases 0 to 4                                   | ~87%     | Was ~85%; resume recap, flags, PDF, cluster edits and prompt admin still open                                                                                   |
| Automated tests (all merged, zero skipped)                     | 2,770+   | `pnpm check` with a database, last run after security M3                                                                                                        |

## Milestones

| Milestone               | Days | State                        | What is in it                                                                   |
| ----------------------- | ---- | ---------------------------- | ------------------------------------------------------------------------------- |
| M0 Land what exists     | 1    | **Done**                     | Working tree committed, three pre-commit gaps fixed                             |
| M1 Pilot-safe           | ~35  | **Done, merged, gate green** | Security, operations, engineering correctness, web truth copy and accessibility |
| M2 Trustworthy          | ~55  | **Done, merged, gate green** | Copy, architecture, tenancy, privacy, security part 2, pipeline, configuration  |
| M3 Complete the spec    | ~60  | **Done, merged, gate green** | Product blueprint features, redesign, observability                             |
| M4 Evidence and A grade | ~50  | **In progress (~90%)**       | Evals, Playwright, load and chaos, pen test, usability tests, drills            |
| M5 Launch               | ~10  | **Done in scope (~90%)**     | Landing page, proof points, name, phase plan says Done                          |

## Grades against the starting point

| Dimension          | Start | Now (estimate)                                                 | Target | Evidence for the movement                                                                  |
| ------------------ | ----- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Security           | C+    | B+/A-                                                          | A      | Guards, rate identity, erasure, SSRF, dependencies, suspension, staff identity merged      |
| Operations         | C+    | B                                                              | A      | Alerting, job admin, heartbeat, timeouts, encrypted backups, rollback scripts merged       |
| Engineering health | B     | B+                                                             | A      | Extraction transaction, retention GC, abort plumbing, honest gate merged; evals still thin |
| Usability          | 6.5-7 | 7 (owner review: visual design was poor; redesign in progress) | 9.5    | Locale fix, contrast, announcer, confirmations, error focus, copy pass merged              |
| Spec coverage      | ~85%  | ~97%                                                           | 100%   | Data model and features in M3                                                              |

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

Nothing running; follow-up wave being launched (see Left).

## Left, in order

1. **Full-stack follow-ups:** full k6 run under default abuse limits, Playwright journeys against the stack. Done (D-280 to D-283): voice first sentence before metadata (p95 1.79 s to 1.04 s at 250 chars/s), orphaned active jobs reclaimed by the next worker, turn-lock TTL 10 s, disk-full upload answers `storage_full`.
2. **Requirement quality:** re-judged through merge v3 on the six fresh interviews: duplicates 24% by judge, 12% by hand (6 of 51, five in one interview) vs <5% target, so still open (D-335); recall measured at 85-87% fresh (earlier lists were padded, not lost); scope-tag and ordering corrections in the read-back now tested, one defect found and fixed (D-334).
3. **M4 remainder:** scheduled model-backed evals, Lighthouse budgets, re-run `pnpm live:run` on the merged tip (concurrent runs are now isolated by `LIVE_RUN_ID`, D-331). Done: tenant-scoped sweeps in retention tests (D-332), a role of their own for tests (D-333). Done: requirements/version pages in the axe inventory, the two drifted e2e fixtures, `scripts/live-run/README.md`, cold-build ordering (D-284).
4. **Owner-only:** pen test budget, counsel review of DPA and consent, security contact, product name, usability tests with real people, restore and chaos drills, live voice on a phone, rotation drill on staging, make security workflow a required check.
5. **M5 close:** phase plan marked Done with evidence links, release notes.

## Known risks and open items

- Full compose stack run end to end with the fake provider (11/11 healthy, load 0 errors, chaos 7/7); never with a real provider, Let's Encrypt or offsite restore.
- Requirement lists still contain duplicates: 12% by hand and 24% by judge on the final code (D-335); grounded 88% verified.
- CSP is enforced but has no week of production data and no Observatory scan.
- Finnish interview quality never run live; GitHub push only tested against a fake.
- Realtime voice sockets have no deadlines or retries.
- Quote redaction after deletion is exact-match only; analyses are flagged stale instead.
- `branding.primaryColor` has no consumer; the consent default is English-only.
- `@aidp/db` and `@aidp/core` still depend on each other (the seeds import core); a cold `pnpm -r build` is ordered by `scripts/with-lock.mjs` (D-284), not by the dependency graph.

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

- 2026-10-14 — Full-stack drill merged (D-250..259): fake provider, production compose run, k6 load (0 errors, first token p95 532 ms, voice 1.44 s), chaos 7/7, ten defects fixed (Caddyfile never loaded, upgrades rolled themselves back, backups >64 KB failed verification, session seq race, and more). Five open findings recorded in docs/team/drills/. Gate green.

- 2026-10-14 — Reliability follow-ups merged (D-280..284): voice speaks first sentence early (p95 1788 → 1040 ms), orphaned active jobs reclaimed via worker lease, turn lock recovers in ~10 s, storage_full 507 with en/fi wording, three drifted e2e fixtures fixed (354 e2e checks, axe clean, error screens now fail), cold build fixed, live-run README. Gate green.

- 2026-10-14 — Requirement quality second pass merged (D-290..294): grouped merge, found and fixed read-back never running when owner presses done (11 of 14 saved transcripts were never read their list), unreviewed-list open question, read-back correction eval. Fresh 6: duplicates 11% by judge, grounded 93%; loss of requirements not ruled out. Gate green.

- 2026-10-14 — Second full-stack drill and M5 paperwork (D-310..317): merged tip did not build into a server image (fixed), chaos 7 of 7, load at default abuse limits found 60 of 90 office arrivals and a concentrated launch refused (per-address bucket 30 to 120, campaign hour 120 to 300, tenant hour 500 to 1000), backup and ops-notify run as non-root, object-store quota errors map to `storage_full`, phase plan marked, `docs/RELEASE-NOTES.md`.

- 2026-10-14 — Stack re-verification merged (D-310..317): chaos 7/7 and journey on the merged tip; found the merged tip could not build (Dockerfile missing with-lock.mjs); abuse defaults raised after load showed an office of 90 behind one address was 2/3 turned away; backup and ops-notify now non-root; S3 quota classifier; phase plan re-marked with evidence; docs/RELEASE-NOTES.md written. Gate green.

- 2026-10-14 — Demo run merged (marketing/demo-2026-10: 58 screenshots, EN voice-over scripts) and recall measurement merged (D-300..305): requirements not lost, earlier lists padded; live re-run found and fixed duplicated FR ids after stale extraction write-back (D-302) and a silent cluster failure on a 1,300-char rationale (D-304). Demo scripts broke the web image build/lint; excluded from web tsconfig and eslint. Fix wave for demo-exposed defects (diagrams illegible, department panel clipping, MVP challenge state, currency, analysis versions, end screen, voice screen) running. Gate green.

- 2026-10-14 — Demo-defect fixes merged (D-320..326): diagrams illegible was prefers-reduced-motion CSS forcing .01ms transitions during mermaid measuring (fixed, PDF diagrams verified with real Kroki); layout clipping; MVP challenge state truthful; branding.currency; analysis auto-run debounce; summary endpoint returns status and never the last reply; voice screen in axe. e2e 408/408, axe clean. Merge also tripped the double-cast ratchet (49 vs 45), fixed by typing the tests. Gate green. All agent waves done; remaining items are owner-only or measured follow-ups.

- 2026-10-14 — Follow-up closure (D-330..D-335): `upgrade.sh` waits for a healthy backup container and fails on a crash loop (D-330); `live:run` isolated by `LIVE_RUN_ID` with a lock for the default names (D-331); retention tests sweep only their own tenants, so the gate no longer depends on leftover test tenants (D-332); tests log in as their own role instead of re-passwording `app_api`, which ends the P1000 cross-process flake (D-333); scope tags `"Future"`, `"later"` and the like were read as MVP, fixed with four read-back eval cases (D-334); duplicates re-judged on the final merge code: 24% judge, 12% hand, still over 5% (D-335).

- 2026-10-14 — Owner reviewed the UI and rejected it as low effort (bare landing, no admin topbar/breadcrumbs/profile, content floating, no pagination/filter/upload/toast/loading standards, not responsive). Accepted: tests and axe were not a design bar. Landing redesign merged (D-350..359, Lighthouse a11y/BP/SEO 100), admin shell + UI kit merged (D-340..349: shell, DataTable, form kit, upload, toasts, account page; 6 pages converted), engineering leftovers merged (D-330..335; duplicates still 12-24%). Page conversion wave launched for all remaining pages. Demo re-record paused until UI settles.
