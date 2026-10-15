# Release notes, October 2026

The release is a git SHA, as the stack deploys it (`deploy/versions.env` records the running and the
previous one); there is no version number to quote. This is the state of the branch
`claude/ai-discovery-platform-bzxmqw` at the end of the M5 paperwork, 2026-10-14, covering phases 0
to 5 of [the phase plan](spec/15-phase-plan.md).

Three documents sit under this one and carry the evidence. Read them before repeating any claim:

- [Claims inventory](team/claims-2026-10.md): every sentence the product may say about itself, as
  Built, Partial or Planned, with the file or test that shows it. The landing page is tested against it.
- [Security verification](team/security-verification-2026-10.md): 35 rows, 29 closed, 5 partial, 1
  open (the external penetration test), with the commands that were run.
- [Drills](team/drills/): the production stack run twice end to end
  ([first](team/drills/2026-10-14-full-stack.md), [second](team/drills/2026-10-14-full-stack-2.md)),
  chaos and load records, and what each found.

## What is built

**Interviews.** Templated discovery interviews with a recorded reason per turn, answer options,
adaptive length, resumable sessions with a recap, and English and Finnish interfaces; participants
need no account. Text, recorded voice, live voice (WebSocket, streaming captions, barge-in, fallback
to typing) and documents or photos with recall in later turns.

**Analysis.** Facts extracted on a fixed schema, embedded or lexically clustered, merged, named and
ranked on seven tenant-tunable factors, with k-anonymity on quotes, roles, tools and departments,
cluster edits by an administrator, department comparison, and a report as Markdown or PDF that
states its own method and what it does not do.

**Specification.** A requirements interview (context first, then areas, one decision per question,
issue detection, MVP challenge, a read-back of the list), versioned specifications with stable ids
and diffs, editable diagrams, PDF, and an agent bundle for Claude Code and Codex; an opportunity
hands off into a requirements session. A coding agent built features from a generated bundle
([acceptance](team/phase3-acceptance.md)).

**Privacy.** Anonymous campaigns keep a salted hash and no pointer from answers; one definition of
erasure across participant deletion, the delete job and the retention sweep (a canary scans every text
column); participant data download; retention sweep; audit log, append-only and hash-chained; a
record of processing generated from the code.

**Operations.** One VPS behind Caddy: `deploy/upgrade.sh` and `rollback.sh` with SHA tags, a mandatory
pre-upgrade backup, a maintenance page, a failing migration that leaves the old containers running;
encrypted backups with a weekly restore drill and an offsite option; 14 alert kinds to email and a
webhook with a runbook each; job administration; budgets at tenant, campaign and session; prompt
administration with tenant versions, canary and rollback; Grafana dashboards with SLO panels in
`deploy/observability`.

**Quality gate.** `pnpm check` (format, build, typecheck, lint, tests) with a database; 2,770+ tests,
no skipped suite, no network from tests; deterministic engine replays in `evals`.

## What changed in this release's last pass

The second full-stack drill ([record](team/drills/2026-10-14-full-stack-2.md), D-310 to D-317):

- **The merged tip could not be built into a server image** (the build lock script was not in the
  image). Fixed (D-314). No deployment of the tip before this was possible.
- **The default abuse limits were too tight for a real launch.** Run against the defaults, one
  campaign took 311 refusals of 499 open attempts in five minutes, and 60 of 90 colleagues arriving
  from one office address in a minute were turned away. The per-address bucket is now 120 a minute
  (`RATE_LIMIT_PUBLIC_MAX`), `abuse.campaignSessionsPerHour` 300 and `abuse.tenantSessionsPerHour`
  1000 (D-310, D-311). The campaign total (2000) is unchanged.
- **The backup and ops-notify containers no longer run as root** (Trivy DS-0002, D-312); backup,
  restore, the restore drill and the disk-full chaos case were verified as the unprivileged user.
- **An object store's quota error is `storage_full`** like a full disk (D-313). There is still no S3
  adapter to call it.
- Chaos suite 7 of 7 and the full journey passed on the merged tip; load at the default limits had 0
  errors and 0 5xx, first token p95 about 0.52 s, live voice first word p95 about 0.93 s, both against
  a scripted provider.

## What is partial

Named in the claims inventory with the sentence you may say instead. In short:

- **Languages.** Interviews in Finnish have never been run live; the interface is tested in both.
- **One question a turn.** Not a guarantee: 0 to 1 of 160 turns by judge, 7 to 11 by heuristic.
- **Requirement lists** carry about 11 percent duplicates by the judge (target 5); whether a stated
  requirement is sometimes lost is not ruled out (D-294).
- **GitHub push** has run only against a fake.
- **Voice** has run only against a scripted provider and test sockets, never a real realtime
  provider or a phone; the on-host Whisper model was never loaded in a drill.
- **Embeddings.** Clustering falls back to lexical overlap unless an `embedding` route exists
  (OpenRouter serves none); the pgvector path has run in tests only.
- **Quote redaction after a deletion** is exact-match; an analysis is flagged stale instead.
- **Cost per interview** (1.4 to 2.2 cents) is a test figure from simulated interviewees.
- **CSP** is enforced, with no week of production report data and no Observatory scan.
- **Object storage** is a directory (or memory in development); there is no S3 adapter.
- **Load and chaos** were run on one machine, one tenant, a fake provider, Caddy's local CA and no
  offsite copy; they say nothing about a mobile address pool or a database of real size.
- **Not built at all:** SSO beyond Google, Slack or Teams, Jira or Linear, webhooks and API keys as
  a product, real-time collaboration, billing and self-serve sign-up, self-hosted text-to-speech,
  high-availability deployment, certifications (phases 6 to 8 and the Planned rows of the inventory).

## What is owner-only

Things no change to the repository can complete; the owner or a counsel does them.

| Item                                                                                                                         | Where it is tracked                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Security contact address in `security.txt` and `SECURITY.md`, mailbox, GitHub private reporting                              | [security verification](team/security-verification-2026-10.md) O1     |
| Make the `security` workflow a required check; Code Owner review                                                             | O2 (repository settings)                                              |
| One rotation drill on staging, written into `OPERATIONS.md`                                                                  | O3                                                                    |
| Counsel review of the DPA template and consent text; `/privacy` cookie page words                                            | O5, [DPA-template.md](DPA-template.md)                                |
| A model-backed injection run with a key and an agreed threshold                                                              | O6                                                                    |
| HSTS preload once every subdomain is verified                                                                                | O7                                                                    |
| External penetration test and its budget                                                                                     | O8, claims F8                                                         |
| Product name; live voice in the first pilot (default behind its flag)                                                        | [tracker](team/completion-tracker.md#decisions-waiting-for-the-owner) |
| A pilot: a real provider key, a real domain with Let's Encrypt, an offsite remote and one restore from it on another machine | [DEPLOY.md](DEPLOY.md#before-you-go-live)                             |
| Live voice on a phone; a Finnish interview run live; usability tests with real people                                        | tracker, "Owner-only"                                                 |

## Upgrading from the previous release

`deploy/upgrade.sh` as always. The `ops-state-init` one-shot hands `/backups` and the alert files to
the unprivileged users on the first `up`; there is no manual `chown`. A tenant that set the abuse
limits explicitly keeps its values; a tenant on the defaults gets the higher ones. New optional
variable: `RATE_LIMIT_PUBLIC_MAX` (default 120). No migration.

## Follow-ups closed after this release was written (2026-10-14)

- **Upgrades** wait for the backup container and fail, with its log lines, when it crash-loops or
  never becomes healthy (D-330). The application is left serving; backups are what is reported broken.
- **Specifications:** a requirement an owner moves to "Future" or "later" at the read-back is now
  future; before, only the exact lowercase `future` counted (D-334).
- **Engineering:** `pnpm live:run` runs side by side with `LIVE_RUN_ID` (D-331); the retention tests
  no longer slow down with leftover test tenants (D-332); tests use a login role of their own, which
  removes an authentication flake against other stacks on the same Postgres (D-333).
- **Still true, and measured again:** duplicates in requirement lists are not under 5%. On the six
  fresh interviews through the final merge code, 24% by the judge and 12% by hand (D-335).

## Changes after the owner's review (2026-10-14 to 2026-10-15)

**Upgrading a server installed before this:** run `mv deploy/.env .env` from the repository root
first. Production now reads the root `.env`; every deploy command stops with this instruction until
it is done (D-450). Then `deploy/upgrade.sh` as always. Migration 0027 (platform logo) is additive.

- **One configuration file.** Development and production both read the root `.env`, documented
  section by section in `.env.example`; `deploy/generate-env.sh` writes it (D-400..407, D-450..459).
- **Email relay in separate fields:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`,
  `SMTP_PASSWORD`, `EMAIL_FROM`, the same as the admin form; the old `EMAIL_SMTP_URL` still works
  (D-445..449). The admin form tests a relay with "Send test email" (D-410..416).
- **First sign-in and lock-out:** `deploy/signin-link.sh <email>` prints a one-time, 15-minute
  sign-in link for an existing staff user, audited (D-440..444). See DEPLOY.md, "How the first admin
  signs in".
- **Branding:** the site name and an optional logo (PNG, JPEG or WebP) are set in Settings → Branding;
  no letter tile (D-430..439).
- **Interface:** admin shell with top bar, breadcrumbs, search and account page; tables with server
  pagination, filters and icon actions; redesigned landing page; participant interview as a
  messenger with voice answers inside the bubbles, a laptop layout with a side panel, and no answer
  mode switch; participant welcome text per campaign instead of the template's instructions to the
  AI (D-340..399, D-420..425, D-460..469).
- **Fixed in the end-to-end simulation (27 issues, `docs/team/simulation-2026-10-15.md`):** among
  them invitations reporting an error after sending, colleagues behind one office address not getting
  codes, duplicated facts inflating the analysis, requirements started from an opportunity failing.
- **Tenant context:** a database query returned unawaited from a system-tenant callback ran outside
  its context, so row-level security could hide every row (local transcription route, retention
  sweep). Fixed at the source with a test.
- **Repository layout:** apps, packages, deploy, docs, tools, scripts; see README.md.
- **Marketing:** `marketing/` holds 30 screenshots and the voice-over (full and 60-second cuts) from a
  simulated demo with fictional people; `tools/marketing/` retakes them against a running stack.
