# Security

What this platform protects, from whom, how, and what it does not protect against. Written for
a customer's security reviewer, for the operator, and for anyone who finds a flaw and wants to
know where to send it. The decisions behind each control are in
[`discovery/decisions.md`](discovery/decisions.md) (D-81 to D-89, D-160 to D-166, D-260 to D-269);
the requirement text is [`spec/11-security-and-privacy.md`](spec/11-security-and-privacy.md); the
state of the verification is [`team/security-verification-2026-10.md`](team/security-verification-2026-10.md).
Operating the incident runbooks is [`OPERATIONS.md`](OPERATIONS.md#security-incidents).

Every control below names the test that proves it. A claim with no test is marked as such.

## Reporting a vulnerability

> **OWNER ACTION REQUIRED.** The contact address is a placeholder. Replace `security@<your-domain>`
> here, in `apps/web/public/.well-known/security.txt` and in GitHub's private vulnerability
> reporting settings before the first customer is onboarded. Until then the repository's
> `node scripts/security-gates.mjs security-txt` prints a note on every run.

- **Contact:** `security@<your-domain>` (placeholder). Use GitHub's private vulnerability report on
  the repository if the mailbox is not yet live.
- **What to include:** what you found, how to reproduce it, and what you believe it exposes. Do not
  include real personal data; a description of where it is reachable is enough.
- **What happens:** acknowledgement within 3 working days; a first assessment within 10; a fix or a
  stated plan within 90 days, and coordinated disclosure on a date we agree. We credit reporters who
  want credit. There is no bounty.
- **Safe harbour:** testing that stays within your own account or tenant, that does not read,
  modify or delete another person's data, that does not degrade the service for others, and that
  stops and reports on first contact with personal data, will not be pursued. Social engineering,
  physical access and volumetric denial of service are out of scope.
- **Machine-readable:** `/.well-known/security.txt` (RFC 9116). CI fails when its `Expires` has
  passed or is more than a year away.

## What is protected

| Asset                                                       | Why it matters                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Interview transcripts, recorded voice, uploaded documents   | Personal data about employees, often about their work and their employer     |
| Participant identity (name, address, role, department)      | The link between a person and what they said; anonymity is a promise to them |
| Facts, reports, specifications                              | A tenant's operational knowledge; sometimes sensitive by itself              |
| Provider API keys, SMTP credentials, GitHub tokens          | Spend money and send mail as the platform or the tenant                      |
| Platform secrets (`PLATFORM_ENCRYPTION_KEY`, `AUTH_SECRET`) | Open every stored secret, or forge any staff session                         |
| The audit log                                               | The only evidence of who did what, to the data above                         |
| Availability and mail reputation                            | A flooded link or a mail-bombed address costs money and a sending domain     |

## Who is assumed to attack

| Actor                       | Capability assumed                                                                |
| --------------------------- | --------------------------------------------------------------------------------- |
| Anonymous link holder       | Has a campaign link; can script it; can rotate addresses; can send any bytes      |
| Participant                 | Holds one session token; can reuse it after deletion; can try other sessions' ids |
| Malicious tenant member     | Signed in, role `member`; probes admin routes and other tenants' ids              |
| Malicious tenant admin      | Full control of one tenant's settings, including provider and SMTP URLs           |
| Platform operator           | Trusted, and audited; can act inside any tenant                                   |
| Model providers             | See the content they are sent; return untrusted text                              |
| A document or a participant | Carries instructions meant for the model, or bytes meant for the parser           |
| Supply chain                | A dependency, a base image or a GitHub Action that has been compromised           |

## Trust boundaries

Each boundary lists the threats considered (STRIDE), the control, and the test or check that holds it.

### 1. Browser to Caddy (the edge)

| Threat                                            | Control                                                                                                                    | Evidence                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Spoofing the client address to pick a rate bucket | Caddy writes one `X-Forwarded-For` from the socket; the API trusts a stated hop count; IPv6 is bucketed by /64 (D-82)      | `client-identity.e2e.test.ts`              |
| Interception, downgrade                           | TLS from ACME, HSTS one year with subdomains; `upgrade-insecure-requests` in the enforced CSP                              | `deploy/Caddyfile`; `caddy validate` in CI |
| Oversized or dribbled bodies exhaust the web tier | 2 MB on JSON routes, 55 MB on the two upload routes, header and body timeouts (D-87)                                       | `deploy/Caddyfile`; `proxy.test.ts`        |
| Tokens leaking through access logs                | Path tokens and secret query keys are rewritten in the access log (D-223)                                                  | `telemetry` redaction tests                |
| Framing, MIME sniffing, powerful features         | `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (microphone for voice only), `COOP same-origin` | `deploy/Caddyfile`                         |

### 2. Caddy to the web app (the browser's origin)

| Threat                                               | Control                                                                                                                                                                                                                  | Evidence                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Script injection (XSS), including from model output  | A per-request nonce CSP with `strict-dynamic`, no `unsafe-inline` for scripts, no remote image or connect host, **enforced** in production (`CSP_MODE`, D-264); report Markdown drops images and non-https links (D-165) | `csp.test.ts`; Playwright `axe.spec.ts` fails on any `securitypolicyviolation` |
| Cookie theft, fixation, planting from a sibling host | Participant credential is `HttpOnly`, `SameSite=Lax`, `Secure`, and `__Host-` prefixed in production (D-263); staff sessions are Auth.js JWTs, 8-hour sessions are an open item (see verification)                       | `participant-cookie.test.ts` (web and API)                                     |
| Cross-site request forgery on the proxy              | Same-site check on state-changing proxy calls; Lax cookies                                                                                                                                                               | `proxy.test.ts`                                                                |
| Header injection through the proxy                   | Only an allow-list of request headers is forwarded; hop-by-hop headers are dropped                                                                                                                                       | `proxy.test.ts`; verification probe                                            |

### 3. Web app to API (the internal network)

| Threat                                       | Control                                                                                                                                                                                       | Evidence                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Reaching the API directly                    | The API is not published; only the voice WebSocket path is forwarded, and it authenticates with the participant cookie                                                                        | `deploy/compose.prod.yml`, `deploy/Caddyfile` |
| Calling a route without the right role       | Every route declares `public`, `participant`, `staff`, `admin`, `operator` or `internal`; the guard runs in `onRequest`, before the body is parsed; an undeclared route stops the boot (D-88) | `role-matrix.e2e.test.ts` and its snapshot    |
| Forging the machine credential               | The internal secret is an HKDF derivation of `AUTH_SECRET`, compared in constant time; `AUTH_SECRET` itself does not open internal routes (D-260)                                             | `internal-auth.e2e.test.ts`                   |
| Reading another tenant's object by id        | Every tenant-owned query is scoped by `companyId` and fenced again by row-level security (below)                                                                                              | `rls-conformance.integration.test.ts`; probes |
| Abusing an open link                         | Per-IP buckets, per-campaign and per-tenant hourly buckets, a campaign total, a distinct-address cap on code requests, all counted in Postgres; `abuse.limit_hit` alerts (D-261)              | `abuse.e2e.test.ts`, `code-caps.e2e.test.ts`  |
| An operator or reader acting without a trace | `operator.access` and `session.read` audit rows (D-262)                                                                                                                                       | `audit-reads.e2e.test.ts`                     |

### 4. API and worker to Postgres

| Threat                                 | Control                                                                                                                                                                                                | Evidence                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| A query that forgets the tenant filter | The application connects as `app_api`, which cannot bypass RLS; each table has a `tenant_isolation` policy on `app.company_id`; the preflight refuses to start the stack when a table has none (D-140) | `rls-conformance.integration.test.ts`, `deploy/preflight.sh` |
| Editing or removing audit rows         | `AuditLog` is append-only for every role by trigger and privilege, and hash-chained per tenant; `audit_chain_verify()` runs daily (D-163)                                                              | `audit-append-only.integration.test.ts`                      |
| Writing content into a deleted session | Insert triggers on content tables refuse a deleted session (D-89)                                                                                                                                      | `erasure.e2e.test.ts`                                        |
| Secrets at rest                        | AES-256-GCM, HKDF-derived key, purpose-bound AAD, key id in the ciphertext; rotation by `crypto.rekey` (D-164)                                                                                         | `crypto-admin.e2e.test.ts`, `rekey.integration.test.ts`      |
| Identity of staff                      | One tenant per address, globally unique, lower-case (D-84); disabled users and revoked sessions are refused on every request (D-161)                                                                   | `staff-identity.e2e.test.ts`, `user-offboarding.e2e.test.ts` |

### 5. API and worker to the outside (model providers, SMTP, GitHub, Kroki)

| Threat                                                 | Control                                                                                                                                                                                                 | Evidence                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| SSRF through a tenant-set URL (provider, SMTP, GitHub) | One egress policy by origin; the address the socket connects to is checked on every connect; redirects refused; responses capped; metadata addresses always denied; upstream text never returned (D-83) | `egress-strict.e2e.test.ts`, `egress.test.ts`    |
| A hung provider holds a turn                           | Timeouts and a first-token deadline on every provider call; a circuit breaker per provider (D-228)                                                                                                      | `provider-timeouts.test.ts`                      |
| Spend                                                  | Budgets and ceilings at the point of use; one model entry point (`ModelCaller`)                                                                                                                         | `callModel.test.ts`, `budget-alerts.e2e.test.ts` |
| Provider keys in logs, responses or diffs              | Secrets are sealed, never returned (a sentinel is), and never written to audit diffs or logs (D-223)                                                                                                    | `provider-headers.e2e.test.ts`                   |

### 6. Content: documents, recordings, prompts

| Threat                                                | Control                                                                                                                                                                               | Evidence                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| A malicious file (bomb, polyglot, renamed executable) | Streamed to a cap before it is stored; signatures checked by type; archives inflated and counted (entries, size, ratio, DOCTYPE/ENTITY); quotas per interview and per tenant (D-160)  | `upload-hardening.e2e.test.ts`, `ingest/hostile.test.ts` |
| Prompt injection from a participant or a document     | Untrusted text is delimited and never in the instruction position; extraction output is verified (quotes must exist in the source); the report renderer cannot load a remote resource | `evals/src/injection.eval.ts`                            |
| Re-identification of an anonymous participant         | Per-campaign salted email hash, no stored pointer from a response to an address, day-resolution times, k-anonymity on quotes, evidence and groups (D-142)                             | `anonymity.e2e.test.ts`                                  |
| Data kept after a deletion request                    | One definition of deletion (`eraseSession`) for the participant, the job and the retention sweep; an erasure ledger re-applies deletions after a restore (D-81, D-226)                | `erasure.e2e.test.ts`, `privacy-retention.e2e.test.ts`   |

### 7. Supply chain and build

| Threat                                    | Control                                                                                                                                                                                      | Evidence                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| A vulnerable dependency                   | `pnpm audit --prod --audit-level=high` with expiring, justified ignores; Trivy over the lockfile and over both images, failing on fixable HIGH and CRITICAL; weekly Dependabot (D-85, D-267) | `.github/workflows/security.yml`, `ci.yml`                        |
| A leaked secret in history                | `gitleaks` over the full history with a committed configuration (D-267)                                                                                                                      | `.gitleaks.toml`                                                  |
| A compromised GitHub Action               | Every action is pinned by commit SHA, with minimal workflow permissions; Dependabot raises the update                                                                                        | `scripts/security-gates.mjs workflows`                            |
| A model or network call outside the guard | ESLint fences: no provider adapter outside `packages/ai/src/providers`, no global `fetch` outside the egress-guarded modules (a shrinking ratchet lists what remains)                        | `scripts/architecture-lint.test.mjs`, `eslint-rules/ratchet.json` |

## What is not defended against

State these to a customer plainly.

- **A compromised host.** Someone with root on the VPS has the database, the keys in the
  environment, the uploads and the backups' decryption identity. Disk encryption, host hardening
  and access to the box are the operator's, and are outside this repository.
- **A malicious operator.** The operator can read any tenant's data by design (it is a single-operator
  service). Access through `X-Company-Id` is recorded in the tenant's audit log as `operator.access`,
  and offboarding records survive tenant deletion; a determined operator with database access can
  still read what the database holds. The audit chain makes tampering detectable, not impossible.
- **The model providers.** Transcripts and documents are sent to the provider a route names. The
  sub-processor list ([`SUBPROCESSORS.md`](SUBPROCESSORS.md)) says which, and the consent text names
  them. The platform does not defend against a provider's retention or training practices beyond
  the contract the tenant chooses.
- **A malicious tenant admin acting on their own tenant.** An admin can export, read and delete
  everything in their tenant. That is the role. Their actions are in the audit log.
- **Volumetric denial of service.** One VPS behind Caddy has no scrubbing. Application-layer limits
  stop a script, not a botnet.
- **Phishing and mailbox compromise of staff.** Sign-in is a magic link or Google. There is no
  platform-enforced second factor; a staff member whose mailbox is taken is a staff member who is
  signed in. The 30-day session lifetime is an open item in the verification report.
- **Anonymity against a very small group.** k-anonymity hides quotes, roles and departments below a
  threshold, but a campaign of three people about one ward is identifiable by its content. The
  consent text says so.
- **Side channels in the model.** A model asked to extract facts can be persuaded to put an
  instruction's wording in a fact. Extraction output shown to admins is escaped and quote-verified;
  it is not proof that the model obeyed.

## Known residual risks

Tracked, with severity and status, in the verification report. The ones an outside reviewer should
know: the platform has had no external penetration test (criterion 15 of the programme); the
operator can link participants to hashes with the platform key; model-backed injection rates are
recorded by `evals/` only when run with a key.

## Verifying it yourself

```bash
pnpm check                                   # build, typecheck, lint, every test, the security gates
pnpm audit --prod --audit-level=high         # dependency advisories in what ships
node scripts/security-gates.mjs workflows    # actions pinned by commit SHA
node scripts/security-gates.mjs security-txt # security.txt present and unexpired
pnpm --filter @aidp/web e2e                  # Playwright: axe and the CSP-violation assertion, enforced
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.28.0 detect --source /repo --config /repo/.gitleaks.toml --log-opts="--all"
```

The `security` workflow runs the scanners on every push and weekly: Trivy over the lockfile, over
both Dockerfiles and over both built images, and gitleaks over the full history.

## Changing this file

A change to a control changes this file in the same commit, and a decision row. The statement
"defended" appears only next to a test or a check that fails when the control is removed.
