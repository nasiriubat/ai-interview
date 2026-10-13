# Engineering health program: B to A

I read AGENTS.md, the evals section of spec 03, spec 12, `evals/README.md`, the status review, and the code behind each item. No files were modified. Line numbers are as of today's tree.

Two facts from the code changed my designs:

- **Fact duplication is already latent.** `extractFacts` keeps `state.facts` in the session state (layer 2) and the worker separately writes `Fact` rows. The state is saved per batch, but the rows are written once, after the loop. The `Fact` model has no unique key, so a naive retry would also duplicate rows.
- **Batch concurrency is not real.** `JobQueue.consume` (`packages/core/src/jobs/pg-boss.ts:84`) calls `boss.work({ batchSize: concurrency })` and then runs the jobs in a sequential `for`. Two consequences:
  - Concurrency 2 gives no parallelism.
  - If job 2 throws, pg-boss fails the whole batch, so job 1, which already succeeded, is retried.

Two other findings from the code:

- **Engine fakes.** `evals/src/model-script.ts` and `requirements-model.ts` each do `this as unknown as ModelCaller`. `ModelCaller` is a class with private fields, so `implements` does not work on it today (see 2.7).
- **Settings descriptions.** `SettingDef.description` is a single English string. "Both locales" therefore means an `i18n` entry per key in `apps/web/src/i18n/{en,fi}.ts`, or a schema change (see 4.3).

---

## 1. Correctness fixes with designs

### 1.1 `session.extract`: one transaction, one idempotency key

**Problem.** `extractFacts` persists state per batch. The worker then creates `Fact` rows in a loop after every batch has returned. A crash in between leaves `lastExtractedSeq` advanced and the rows never written. The retry sees nothing pending, so the data loss is permanent. The `Fact` rows also have no uniqueness, so any fix that re-extracts would duplicate them.

**Boundary.** One database transaction per batch. It contains the `Fact` insert, the `saveState` (facts plus `lastExtractedSeq`) and the `facts_extracted` event. The model call stays outside the transaction, because a transaction held open across a 4,000-token call is the wrong shape.

**Port change** (`packages/ai/src/engine/ports.ts`). Add one method to `SessionStore`:

```ts
commitExtraction(sessionId: string, input: {
  state: SessionState;            // new facts + lastExtractedSeq
  facts: Fact[];                  // this batch only
  fromSeq: number;                // previous lastExtractedSeq (compare-and-set)
  toSeq: number;                  // upToSeq
  extractorVersion: string;       // promptVersionTag(prompt), replaces hardcoded "extraction@1"
  event: { type: "facts_extracted"; payload: unknown };
}): Promise<"committed" | "stale">;
```

- `extractFacts` calls `commitExtraction` in place of `saveState` plus `appendEvent`.
- It stops returning facts for the worker to persist. The worker's `for` loop over `deps.db.fact.create` is deleted and the handler just logs.
- `PrismaSessionStore` implements it with `db.$transaction([...])`, scoped through the tenant client.
- `MemorySessionStore` implements it atomically in memory. The fake needs a `failAfter` hook so tests can throw between the state write and the row write.

**Idempotency key.** Add `batchEndSeq Int` and `ordinal Int` to `Fact`, with `@@unique([sessionId, batchEndSeq, ordinal])`. Rows are written with `createMany({ skipDuplicates: true })`.

- This makes a double-run harmless even when two jobs overlap. `singletonKey` only dedupes queued jobs, not active ones.
- `commitExtraction` also does a compare-and-set. It runs `UPDATE session SET state = ... WHERE id = $1 AND (state->>'lastExtractedSeq')::int = fromSeq`.
- When 0 rows are updated it returns `"stale"`, rolls back and re-reads. This closes the race between a retry and a still-running original after `expireInSeconds`.

**Migration.** This is migration 0013. Backfill `batchEndSeq = 0` and `ordinal = row_number()` for existing rows. Old rows are exempt from the key by being unique on their own ordinal.

**Tests.**

- Handler run twice gives the same row count.
- A throw injected after the state write rolls back both.
- Overlapping runs: the loser returns `"stale"` and writes nothing.
- A backlog of 60 messages (three batches) with the second batch's model call failing: batch 1 is durable, the retry resumes at batch 2.
- Property test: for any `failAfter` position, the final `state.facts` count equals the `Fact` row count.

**Effort:** 1.5 days.

### 1.2 Retention orphan recovery: GC pass vs retry job

**Recommendation: a GC pass, not a retry job.**

- A retry job needs a record of what failed. After the rows are deleted nothing remembers the prefix, so it needs a new outbox table and a new job plus its failure handling.
- A GC pass is stateless and self-healing. It also covers other leaks: a crash between rows and bytes, a stale upload that never got a row, and restores from backup.

**Design.** Add `StoragePort.listPrefixes(root, depth)` (and an in-memory fake). The key layout is `{companyId}/{sessionId}/...`, so the GC step is:

1. Per tenant, list session directory names under the company prefix.
2. Diff against sessions whose status is not `deleted`, queried by id set in chunks. A session is an orphan when its row is absent or `status = 'deleted'`.
3. Call `deletePrefix` for each orphan, capped at `RETENTION_GC_MAX_PER_SWEEP = 500`.
4. Log counts and write an audit row (`privacy.storage_gc`).

Run it inside `sweepTenant` after the row batches, so one daily job does both. Add a grace window (skip prefixes younger than 1 hour) so an in-flight upload for a new session is never collected.

Also fix three things:

- `sweepAudio`'s `.catch` just logs. Have it return `bytesFailed` so the GC pass covers it, and drop the comment that claims the next sweep revisits.
- Add `bytesFailed` and `orphansCollected` to `TenantSweep`.
- Fire an `AlertPort` event when `bytesFailed > 0` for two consecutive sweeps (depends on the Tier 1 alert work).

**Tests.** In-memory storage with a seeded orphan prefix and a `deletePrefix` that throws once: sweep 1 leaves it, sweep 2 removes it. Grace-window test. An isolation test confirming tenant A's sweep never lists tenant B's prefix.

**Effort:** 1.5 days.

### 1.3 SSE error event and client-disconnect abort

**Problem 1, error event.** `runTurn` does `for await (const item of stream) send(item)`. The generator catches its own errors and yields an `error` event. Errors thrown by the transport (a `reply.raw.write` failure, or `JSON.stringify`) and errors from `afterTurn` or the follow-up `jobs.publish` after the `ended` event are not covered. A publish failure after `ended` is caught by the generator's catch, so the client then sees `ended` followed by `error`, which contradicts itself.

**Fix for problem 1.**

- Wrap the `for await` in `try/catch` in `runTurn`. On failure, send a final `error` event when the head has been written, then end.
- Move the follow-up `publish` calls into their own try/catch that logs and does not yield an `error` event. The jobs are retriable by the next turn's trigger.
- Add a contract test that the stream always ends with exactly one of `ended`, `turn` or `error`.

**Problem 2, disconnect.** There is no abort path today. If the client leaves, the model call runs to completion, is billed, and the generator is only closed when the next write fails.

**Design, an AbortController through the stack:**

1. `CallRequest` gets `signal?: AbortSignal`. `ChatRequest` and the `Provider.chat/complete/transcribe` signatures also accept it. `speak` and `transcribeStream` already take one or a similar mechanism.
2. `ModelCaller.chat` and `complete` pass `req.signal` to the adapter and combine it with the outbound timeout: `AbortSignal.any([req.signal, AbortSignal.timeout(route.timeoutMs)])`. This is also the fix for status finding 8, which is the same change.
3. The adapters pass the signal to `fetch` (openai-compatible) and to the SDK request options (anthropic).
4. On abort the caller's `finally` still writes the ledger row, with `status: "aborted"` and the usage seen so far. Add `"aborted"` to `LedgerEntry["status"]`. This also addresses the "abandoned streams record zero" finding.
5. `EngineDeps` and `nextTurn(snapshot, answer, settings, { signal })` carry the signal. `streamTurn` takes `options.signal`.
6. `runTurn` creates the controller. It listens with `reply.raw.on("close", () => { if (!reply.raw.writableEnded) ac.abort() })`.
7. The WebSocket path (voice-live) does the same on socket close or barge-in. This replaces the ad-hoc stop.
8. On abort `streamTurn` does not write an `error` event. It leaves the user's message persisted and releases the lock in `finally`. The next turn call replays naturally.

**Tests.**

- A scripted model that blocks on the signal. After the fake client disconnects, assert the model saw the abort, the lock is released, and a ledger row exists with status `aborted`.
- A thrown write error produces a final `error` event and no `ended`.

**Effort:** 2.5 days.

### 1.4 Provider test through `ModelCaller`: a `probe` purpose

**Add `"probe"` to `PURPOSES`** (`packages/shared/src/purposes.ts`). The settings catalog, routes and budgets are keyed by purpose, so decide each:

- **Routing:** a probe is not routed by the tenant table. `ModelCaller.probe(ctx, providerId, model)` accepts an explicit `{ providerId, model }` pin, which bypasses `RouteResolver` but still goes through `ProviderConfigSource.get(companyId, providerId)`, the price table, the budget estimate and the ledger. This is the only purpose allowed to be pinned, so it is a distinct method rather than a flag on `chat`.
- **Budget:** a new `cost.probeMaxCentsPerDay` setting (tenant scope, default 25). The budget guard counts `probe` spend under the tenant total but also enforces its own cap, so a looping admin cannot burn money. Exclude it from per-campaign budgets.
- **Ledger:** records with `purpose: "probe"`, `ref: { type: "provider", id }`. It appears in `/stats` cost breakdowns under its own bucket.
- **Local transcription provider:** `testTranscription` goes through `ModelCaller.probeTranscription` (the same pinning path, purpose `probe`).
- **Routes defaults test:** `routes-defaults.test.ts` must exempt `probe` from "every purpose has a default route".

`ProvidersService.test` then does one `caller.probe(...)` and keeps its return shape. Delete `this.adapter(p).chat` from `test`, and delete `loadPrices`/`PriceTable` use there. SSRF filtering sits in the adapter and applies for free.

An ESLint restriction (2.5) prevents recurrence: `providers/service.ts` may only import the registry for `listModels`. The `adapter()` accessor would be narrowed to a `ModelCatalog` interface that exposes `listModels` only.

**Tests.** A probe writes exactly one ledger row. A probe over the daily cap is refused. A probe cannot pin a provider belonging to another tenant. An audit row is asserted in the route test.

**Effort:** 1.5 days.

### 1.5 Prompt version from the prompt object

The extraction worker hardcodes `"extraction@1"`, and `interviewer.v1..v3` are dead files.

- Part of the fix is in 1.1 (`extractorVersion: promptVersionTag(prompt)`).
- Make it structural: `Fact.extractorVersion` comes from the `commitExtraction` input, never a literal. A grep-based lint test (`no-restricted-syntax` on string literals matching `/^[a-z_]+@\d+$/` outside `prompts/`) fails the build.
- Delete `interviewer.v1-v3.ts`. If history matters, git has it. Add the hash pin test (3.8) over the survivors.

**Effort:** 0.25 day.

### 1.6 Turn lock heartbeat

The lock TTL is a fixed 120 s from acquisition, set once. A slow turn (a long model call, retries) outlives it, and a second turn then starts concurrently.

**Design:**

- `streamTurn` starts `setInterval(30_000)` (unref'd) that runs `updateMany({ where: { id, turnLockedAt: lockedAt }, data: { turnLockedAt: new Date() } })`, tracking the latest token in a local variable.
- If the update count is 0 the lock was lost: abort via the controller from 1.3 and stop.
- Reduce `TURN_LOCK_TTL_MS` to 90 s (3 missed heartbeats). A crashed process then frees the session in 90 s instead of 120 s, and a live one never loses it.
- `finally` clears the interval before releasing.
- Fake timers make it testable: advance 31 s and assert `turnLockedAt` moved; advance past the TTL with a killed heartbeat and assert a second turn is admitted.

**Effort:** 0.75 day.

### 1.7 `email.send` idempotency

An SMTP send followed by a failed job ack means a retry sends again, up to 5 times.

**Design:**

- A `SentEmail` table: `id`, `companyId?`, `idempotencyKey` (unique), `sentAt`, `messageId`.
- `JobPublisher.publish("email.send", payload, { singletonKey })` already exists. Callers pass `idempotencyKey` in the payload, derived from purpose + target (`invite:${invitationId}`, `code:${codeId}`, `completion:${sessionId}`). Make `idempotencyKey` required in the schema.
- Handler: `insert ... on conflict do nothing`. If it inserted, send, then mark `messageId`. If the row already exists with `messageId`, skip.
- A crash between insert and send would lose the email. So use two phases: the claim row has `state = 'sending'` plus a lease timestamp. A retry within 10 minutes of a `sending` row waits (throws to retry later). After the lease it re-sends. That gives at-least-once with duplicates bounded to crash windows, which is the honest guarantee for SMTP.
- Prune the table after 30 days in the existing daily sweep.

**Tests.** The handler twice gives one `EmailPort.send`. A crash after claim, before send: a retry after the lease sends once. Two concurrent handlers send once.

**Effort:** 1 day.

### 1.8 Worker batch parallelism

**Design.** Replace the sequential loop in `consume`:

```ts
const results = await Promise.allSettled(
  jobs.map(async (job) => {
    /* parse + handler */
  }),
);
```

- Each job's failure is reported through `onError`.
- If any job failed, throw an `AggregateError`. In pg-boss v10+, `work` with `includeMetadata` and per-job `fail`/`complete` is available. Use `boss.complete(name, job.id)` and `boss.fail(name, job.id, err)` per job so only the failed ones are retried, and do not throw from the batch handler at all. Confirm the exact API against the installed pg-boss version in the first hour; this is the only unknown in this item.
- The per-job `CONCURRENCY` map stays and now actually means something. The handler's own `scoped` wrapper uses `AsyncLocalStorage`, which isolates per promise chain, so parallel jobs do not share tenants. Add a test that proves it with two interleaved tenants.

**Tests.** `consumers.test.ts` gets a fake boss. Batch of 3 where job 2 throws: jobs 1 and 3 are completed, job 2 is failed, and wall time is about the longest job, not the sum.

**Effort:** 1 day.

### 1.9 Shutdown handling

Today `SIGTERM` calls `jobs.stop()` with no deadline and then `process.exit(0)`. A second signal during a long job is ignored, and Docker's 10 s default kill arrives first anyway.

**Design:**

- A single `shutdown(signal)` with an `inFlight` guard. A second signal forces exit with code 1.
- `await jobs.stop({ graceful: true, timeout: SHUTDOWN_GRACE_MS })`, default 25 s, configurable via `WORKER_SHUTDOWN_GRACE_SECONDS`.
- Jobs receive the shutdown `AbortSignal` (the same one from 1.3). A long `analysis.run` stops at its next checkpoint, and pg-boss redelivers it.
- Set `stop_grace_period: 40s` in compose for worker and api.
- The API gets the same treatment: `app.close()` and then end SSE responses with a final `error` event of code `shutting_down`, so the client retries instead of seeing a reset.
- Exit code 0 only on a clean drain. Log what was in flight when the deadline hit.
- Pair this with the heartbeat healthcheck from the status doc (a file refreshed only when pg-boss answers).
- Per-job `expireInSeconds` goes in `definitions.ts`: 120 s for session jobs, 1800 s for analysis and spec, 600 s for ingest. A single `expireInSeconds` per definition is needed so a long job isn't redelivered at 15 minutes while it still runs.

**Tests.** The signal handler is extracted into `createShutdown(deps)` so it can be unit tested without exiting.

**Effort:** 1 day.

Section 1 total: about 10 days.

---

## 2. Architecture program

### 2.1 Tenant-owned queries out of routes into services

I grepped direct Prisma operations (`ctx.db.<model>.<find|count|create|update|delete|upsert|aggregate|group>`) in each `routes.ts`. Counts are call sites, so some are repeated reads.

| Module                         | Direct queries in routes.ts                    | Target service                                              | Notes                                                                                                                          |
| ------------------------------ | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| providers                      | 9 (17 lines touch `ctx.db`)                    | existing `ProvidersService`                                 | prices, routes, models, tests; add methods, drop `db` from route deps                                                          |
| stats                          | 9                                              | new `StatsService`                                          | group-bys; give it `(companyId, range)`                                                                                        |
| operator                       | 8                                              | new `OperatorService`                                       | platform scope; takes an `OperatorActor`, not a `companyId`; the only module that may use the unscoped client, behind one file |
| analysis                       | 6                                              | new `AnalysisQueryService` (read side of `AnalysisService`) |                                                                                                                                |
| settings                       | 6                                              | `SettingsAdminService`                                      | wraps `SettingsService` with audit                                                                                             |
| users                          | 6                                              | new `UsersService`                                          | also the place to enforce the staff-email-per-tenant fix                                                                       |
| audit                          | 4                                              | new `AuditService`                                          | `list(companyId, page)`                                                                                                        |
| campaigns                      | 3                                              | existing `campaigns/service.ts`                             |                                                                                                                                |
| sessions                       | 3                                              | new `SessionsService`                                       |                                                                                                                                |
| participant                    | 2                                              | existing `participant/service.ts`                           |                                                                                                                                |
| health, privacy, internal-auth | 1 each                                         | leave or move                                               | health `SELECT 1` is not tenant-owned and can stay; privacy and internal-auth: move to their services                          |
| voice, requirements, templates | 0 direct (calls to services, passing `ctx.db`) | none                                                        | already compliant in shape                                                                                                     |

That gives 11 modules with direct queries in routes (providers, stats, operator, analysis, settings, users, audit, campaigns, sessions, participant, privacy, plus the two single-line ones), matching the review's "11 of 16". Total is about 60 call sites.

**Rule for the services.**

- Every public method takes `companyId: string` as its first parameter (or an `Actor` that carries it). It is not optional, not nullable, and not derived from a request.
- Services construct the scoped client themselves: `forCompany(this.db, companyId)` (typed per 2.6).
- Routes may call `ctx.services.x.method(user.companyId, ...)` and nothing else.
- Enforcement is an ESLint rule (2.5), `no-restricted-syntax` on `MemberExpression[object.property.name='db']` in `**/routes.ts`, plus `ctx.db` removed from the type route handlers receive. Better: routes receive `RouteContext = Omit<AppContext, "db">`, so it cannot compile.
- Each move ships with a cross-tenant test: tenant B's id in the path returns 404, not 403, and the audit row appears for mutations.

**Effort:** 5 days (stats and operator are the large ones).

### 2.2 Split `packages/core/src/requirements/service.ts` (1,035 lines)

The class mixes sessions, invitations, versions and exports, plus a block of error classes.

| New file                      | Contents (current line ranges)                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requirements/errors.ts`      | the 10 error classes (979-1035)                                                                                                                                                         |
| `requirements/types.ts`       | `Viewer`, `RequirementsSession`, `RequirementsListItem`, `SpecVersionSummary`, `InviteView`, `ExportFormat`, deps (47-143)                                                              |
| `requirements/sessions.ts`    | `create`, `list`, `get`, `liveSpec`, `setPath`, `assertTurnAllowed`, `requestCompletion`, `reopen`, `editSection`, `settleFinding`, `preview`, `load`, `appendEvent` (150-400, 766-835) |
| `requirements/versions.ts`    | `queueVersion`, `runGeneration`, `listVersions`, `getVersion`, `diffVersions`, `versionRow`, `parseEdits`, `versionSummary` (403-563, 878, 930-965)                                     |
| `requirements/exports.ts`     | `exportVersion`, `pushToGitHub`, `bundleFormat`, `slug` (564-617, 847)                                                                                                                  |
| `requirements/invitations.ts` | `invite`, `revokeInvitation`, `resolveInvite`, `openInvite`, `findInvitation` (618-765, 889)                                                                                            |
| `requirements/service.ts`     | a thin `RequirementsService` facade composing the four, so existing imports and the worker keep working                                                                                 |

Each part takes the same deps object and a shared `RequirementsContext` (db, settings, jobs, log). Public API unchanged, so the move is mechanical and lands behind green tests. Do versions first (it carries the worker-facing `runGeneration`).

**Effort:** 2 days.

### 2.3 Split `apps/api/src/modules/participant/voice-live.ts` (753 lines)

The `LiveVoiceSession` class holds the socket protocol, STT streaming, fallback logic, turn running, TTS, and metrics.

| New file                   | Owns                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `voice-live/protocol.ts`   | client and server frame types plus zod parsing (`onMessage` decoding, `send`, `safeJson`) |
| `voice-live/audio-gate.ts` | `admit`, `collect`, `stream`, `reset`: byte ceilings and buffering                        |
| `voice-live/stt.ts`        | `openStream`, `pump`, `onSttEvent`, `onFinal`, `fallBackFromStream`, `hasRoute`           |
| `voice-live/turn.ts`       | `onUtterance`, `drainPending`, `onProviderFailure` (calls `streamTurn`)                   |
| `voice-live/tts.ts`        | `speak`, `speakLast`, `barge`                                                             |
| `voice-live/metrics.ts`    | `recordMetrics`                                                                           |
| `voice-live/session.ts`    | `LiveVoiceSession`, a small state machine that wires the above; `run()` and `settings()`  |
| `voice-live/routes.ts`     | `participantVoiceLiveRoutes` (the Fastify piece, 86-124)                                  |

Make the session an explicit phase machine (`idle | listening | thinking | speaking | closed`) with a single `transition()` so illegal transitions are testable. Each collaborator takes ports (`Clock`, `SttPort`, `TtsPort`, `TurnRunner`) so unit tests need no socket. The existing `voice-live.e2e.test.ts` stays as the safety net and runs before and after each extraction.

**Effort:** 2.5 days.

### 2.4 Split `apps/web/src/hooks/useLiveVoice.ts` (741 lines)

The hook holds about 30 refs. The audio, socket and state machine are interleaved.

| New file                 | Owns                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `live-voice/types.ts`    | status/problem types, callbacks, controller (77-136)                                                                                                               |
| `live-voice/frames.ts`   | `ClientFrame`/`ServerFrame` types and encode/decode                                                                                                                |
| `live-voice/socket.ts`   | `LiveSocket` class: open, reconnect budget (`reconnectsRef`), close handling (`open`, `onClose`, `send`)                                                           |
| `live-voice/capture.ts`  | `Capture` class: stream, `AudioContext`, worklet, analyser, meter (`measure`, `startStreaming`, `stopStreaming`, `release`)                                        |
| `live-voice/vad.ts`      | pure silence/barge-in detection from level samples (`tick`, `beginUtterance`, `endUtterance`): a pure function that takes a sample and state and returns an action |
| `live-voice/playback.ts` | `Player` class: object URL, `play`, `stopPlayback`                                                                                                                 |
| `live-voice/machine.ts`  | pure reducer for status transitions (`setPhase`, `giveUp`, `toListening`)                                                                                          |
| `hooks/useLiveVoice.ts`  | about 150 lines that instantiates the classes, bridges to React state, and cleans up in one effect                                                                 |

The win is that `vad.ts` and `machine.ts` become pure and testable under Vitest with no browser APIs. Only `capture.ts` and `playback.ts` need fakes of `AudioContext` and `HTMLAudioElement`.

**Effort:** 2.5 days.

### 2.5 `PageQuery` and the list envelope into `packages/shared`

- Move `PageQuery`, `Page`, `SortDir` and `listSpec`/`ListSpec` to `packages/shared/src/lists.ts`. Keep the Prisma-specific `page()`/orderBy builders in the API.
- Add the envelope as a shared generic:

```ts
export const listOf = <T extends z.ZodType, K extends string>(key: K, item: T) =>
  z.object({
    [key]: z.array(item),
    total: z.number().int(),
    limit: z.number().int(),
    offset: z.number().int(),
  });
```

- The web `list-schemas.ts` (which currently re-declares the shape; see `list-schemas.test.ts`) imports from shared. That removes the duplicate contract and sets up the contract tests in 4.6.
- The API returns the shared type from `toListResponse(key, rows, total, page)`.

**Effort:** 0.75 day.

### 2.5b ESLint `no-restricted-imports` for rules 2 and 5

Add to `eslint.config.js` as flat-config blocks with `files` globs. A file-scoped block overrides the earlier block for its own files, so each exception block must repeat the other restrictions.

```js
// Rule 2: adapters only inside packages/ai/src/providers (and the registry that builds them).
{ files: ["**/*.{ts,tsx}"], ignores: ["packages/ai/src/providers/**", "packages/ai/test/**"],
  rules: { "no-restricted-imports": ["error", { patterns: [
    { group: ["**/providers/anthropic*", "**/providers/openai-*", "**/providers/local-whisper*", "@anthropic-ai/sdk", "openai"],
      message: "Model calls go through ModelCaller (AGENTS.md rule 2)." } ] }] } },
// Rule 5: no network clients outside adapters; tests never hit the network.
{ files: ["packages/core/src/!(email|storage|jobs|providers)/**", "apps/api/src/modules/**"],
  rules: { "no-restricted-imports": ["error", { paths: [
    { name: "node:http" }, { name: "node:https" }, { name: "undici" }, { name: "nodemailer" },
    { name: "@aws-sdk/client-s3" }, { name: "pg-boss" } ] }] } },
```

Plus `no-restricted-globals` for `fetch` in `apps/api/src/modules/**/routes.ts|service.ts` and `packages/core/src/**` (outside `email`, `storage`, `github.ts`, which are the adapters). Rule 2's second half is `Provider` interface use: export `Provider` types from `@aidp/ai` as `type` only, and ban `registry` imports outside `packages/ai/src` and `packages/core/src/providers`.

Rule 5 for tests: add a Vitest `setupFiles` in each package that stubs `globalThis.fetch` and `net.connect` to throw `"network access in tests"`, except the integration project's DB socket. This is the runtime half; the lint rule is the static half.

The `routes.ts` rule from 2.1 goes in the same block. Each new rule lands with its offenders fixed in the same PR, or with a ratchet: an allow-list file in the config that only ever shrinks, enforced by a test that counts the entries.

**Effort:** 1 day.

### 2.6 `TenantPrismaClient`

`forCompany` returns the `$extends` result, whose type is inferred and awkward, and consumers cast it back to `PrismaClient` (the `deleteSessionOps(db: SessionDeleteClient...)` shape in retention.ts is a symptom).

- In `packages/db/src/index.ts`, export:

```ts
export type TenantPrismaClient = ReturnType<typeof buildScoped>;
```

with `buildScoped` returning a named const so the type is stable.

- Services take `TenantPrismaClient`, or a narrow structural interface for what they use, such as the existing `SessionDeleteClient`.
- Make `forCompany` the only way to obtain a tenant-typed client. The services in 2.1 receive the base client in their constructor but expose only methods that scope internally.
- Remove each `as PrismaClient` / `as unknown as` hit as the modules move. The baseline count is the ratchet; the CI step fails if it rises.

**Effort:** 1 day (alongside 2.1).

### 2.7 `implements ModelCaller` in the eval fakes

`ModelCaller` is a class with private fields, so `implements` fails structurally.

- Extract `export interface ModelCallerPort { chat(...); complete(...); transcribe?(...); embed?(...); probe?(...) }` in `packages/ai/src/callModel.ts`, and have `class ModelCaller implements ModelCallerPort`.
- Change `CallerFactory`, the engine deps and the `extract/summary/analysis` deps to accept `ModelCallerPort`.
- `IdealScriptedModel implements ModelCallerPort`. The `asCaller()` method and both `as unknown as` casts are deleted.
- Add `complete<T>` implementations that parse scripted JSON through the schema passed in (so fakes cannot drift from the real schemas).
- Put the fakes in a shared package, `packages/testing` (a new workspace package, dev-only), so api, worker, core and evals all use one `ScriptedModel`, `MemorySessionStore`, `MemoryStorage`, `MemoryJobs` and `FakeClock`. `MemoryStore` in `engine-replay.eval.ts` is currently a local copy of what the worker tests will need.

**Effort:** 1 day.

Section 2 total: about 16 days.

---

## 3. Evals program (NFR-06)

### 3.0 Where we are

- 2 fixtures of 8 and 9 answers, both `opportunity_discovery`.
- Two replay tests with an `IdealScriptedModel` that always answers perfectly, so the model side can never regress and the engine tests cannot detect prompt changes.
- No `eval:live` script, no metrics, no thresholds.
- There are 2 shipped templates (`opportunity_discovery`, `requirements_discovery`). So 12 or more 60-turn transcripts are required (6 per template minimum).

### 3.1 Two tiers

| Tier                        | Runs                                                     | Model                                     | What it proves                                                                                                                                           | Gates                                                                          |
| --------------------------- | -------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Replay** (deterministic)  | every commit, in `pnpm test`                             | scripted: recorded model outputs per turn | the engine, state machine, selection, summary window logic, extraction plumbing, widget policy and stopping rules are unchanged or intentionally changed | fails CI on any metric drop beyond tolerance                                   |
| **Live** (`pnpm eval:live`) | nightly, and on any change under `prompts/` or `engine/` | real providers                            | prompts and models actually work: recall, precision, completeness                                                                                        | fails the nightly; blocks the PR through a required check when prompts changed |

Replay uses **recorded** model outputs, not an "ideal" model. Each live run can write a cassette (`evals/cassettes/<fixture>.<promptHash>.json`: per-call `{purpose, requestHash, response}`). Replay serves cassettes and fails with a precise diff if the request hash for a call changed, which tells the author "the prompt or the context assembly changed; re-record with `pnpm eval:record`". This turns every prompt or assembler change into a visible, reviewable cassette diff.

### 3.2 Fixture matrix

Per template, at least six 60-turn transcripts. Seven personas are required (cooperative, terse, off-topic, hostile, contradicting, language-switching, file-heavy), so 7 fixtures per template, 14 total (2 spare). Personas are per-template scripts, not shared, since coverage areas differ.

Directory: `evals/fixtures/<templateKey>/<persona>.json`.

**Fixture JSON shape** (validate with a zod schema in `evals/src/fixture.ts`; a parse failure fails CI):

```jsonc
{
  "$schema": "./fixture.schema.json",
  "id": "opportunity_discovery/hostile-nurse",
  "version": 1,
  "templateKey": "opportunity_discovery",
  "persona": "hostile", // cooperative|terse|off_topic|hostile|contradicting|language_switching|file_heavy
  "locale": "en",
  "turns": [
    // 60 participant turns, in order
    {
      "n": 1,
      "text": "I do charting. It takes forever.",
      "modality": "text", // text|voice|widget
      "widgetResponse": null, // when answering a widget
      "lang": "en",
      "attachments": [], // ids from `files`
      "labels": {
        // gold annotations for scoring
        "facts": ["f_chart_time"], // facts this turn introduces
        "contradicts": null, // turn n this contradicts
        "offTopic": false,
        "hostile": false,
      },
    },
  ],
  "files": [
    {
      "id": "doc1",
      "filename": "handover.docx",
      "textFixture": "files/handover.txt",
      "facts": ["f_handover"],
    },
  ],
  "goldFacts": [
    {
      "id": "f_chart_time",
      "kind": "task",
      "match": { "name": ["charting"], "minutesPerOccurrence": { "min": 40, "max": 50 } },
      "introducedAtTurn": 3,
      "mustSurviveSummary": true,
    },
  ],
  "goldFindings": [
    // for requirements templates (issue detection)
    { "id": "iss_conflict_1", "type": "contradiction", "turns": [12, 41], "severity": "high" },
  ],
  "expect": {
    "coverage": [
      { "afterTurn": 10, "covered": ["role", "daily"] },
      { "afterTurn": 60, "covered": "all" },
    ],
    "focusOrder": "template",
    "widgets": { "maxPerTurnWindow": { "window": 5, "max": 2 }, "forbiddenOn": ["hostile", "voice"] },
    "stop": { "by": 44, "reason": "coverage_complete" },
    "endedWithin": 60,
    "hostility": { "flaggedByTurn": 8, "interviewerTone": "neutral" },
    "languages": ["en", "fi"],
  },
  "tolerances": { "recallFloor": 0.8, "factAccuracyFloor": 0.75 },
}
```

**Persona intent:**

- **Cooperative:** every area answered, concrete numbers.
- **Terse:** 1 to 4 word answers, tests probing, widget use, and the stopping rule when nothing new arrives.
- **Off-topic:** 40% of turns drift; the engine must steer back without losing the covered state.
- **Hostile:** refusal, insults, "this is pointless". Expect de-escalation, a hostility flag, no data-fishing, and respectful end.
- **Contradicting:** states a value at turn 5 and a different one at turn 40; expect the later one to be preferred with the conflict recorded (for the requirements template, an issue finding).
- **Language-switching:** English and Finnish mixed. Replies follow the participant's latest language; facts are language-normalized.
- **File-heavy:** 6 or more attachments with facts only in files. Tests recall through layer 5 and attachment summaries in layer 2.

Authoring: a generator script `evals/tools/gen-fixture.ts` calls a strong model with a persona brief to produce the turns once, then a human edits the gold annotations. The output is committed; generation is never run in CI. Each fixture needs a reviewer sign-off line in its PR (labelling quality is the evals' ceiling).

### 3.3 Metrics

All pure functions in `evals/src/metrics/*.ts`, each unit-tested with hand-built inputs (so the metrics themselves are tested, not just used).

| Metric                                   | Definition                                                                                                                                                                                                                                                                                                                               | Deterministic (replay)                                                                      | Live                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Coverage progression**                 | at each `expect.coverage[].afterTurn`, the covered set contains the expected areas; also area count over turn as a curve                                                                                                                                                                                                                 | exact match                                                                                 | exact, with a one-turn slack on `afterTurn`                                                           |
| **Fact recall after summary**            | build a context at turn 60 with the rolling summary and the recent window only (no old verbatim turns); ask the recall probe for each gold fact marked `mustSurviveSummary`; recall = facts retrievable from layer 2 (`state.facts`) plus summary plus window, over gold facts                                                           | the assembled context contains the fact (string and structured match): checks the assembler | an LLM judge or structured question answered from the assembled context only; score = recalled / gold |
| **Issue-detection precision and recall** | predicted findings vs `goldFindings`, matched by type plus overlap of cited turns (Jaccard >= 0.5); precision = TP/(TP+FP), recall = TP/(TP+FN), also per severity                                                                                                                                                                       | recorded cassette, exact                                                                    | real `issue_detection` calls                                                                          |
| **Extraction accuracy**                  | for each gold fact, find a predicted fact of the same kind whose `match` constraints hold (field containment and numeric ranges); report precision, recall, F1, plus a hallucination count (predicted facts with no gold counterpart and no supporting turn)                                                                             | cassette                                                                                    | live                                                                                                  |
| **Spec completeness rubric**             | rubric of 10 binary items from spec 05 (each required section present and non-empty, each open question linked to a finding, acceptance criteria testable, no unresolved contradiction hidden, ...), scored by deterministic checks where possible (structure) and an LLM judge for the rest, with the judge's rubric prompt hash pinned | structural items only (cassette)                                                            | all items, 3-sample judge with majority vote                                                          |
| **Widget policy**                        | no widget in voice mode or after a hostile flag; max widgets in any 5-turn window; every widget payload passes the schema and has at least 2 options; the widget response is mapped back into state                                                                                                                                      | exact                                                                                       | exact                                                                                                 |
| **Stopping rules**                       | interview ends by `maxTurns` or coverage-complete + closing + summary; never ends before the closing question; never continues after `endInterview`; turn count <= `expect.endedWithin`; no more than 2 consecutive probes on a covered area                                                                                             | exact                                                                                       | exact                                                                                                 |
| **Hostility handling**                   | flag raised within N turns; zero follow-up probes that escalate; end offered                                                                                                                                                                                                                                                             | cassette                                                                                    | live with judge                                                                                       |
| **Language**                             | reply language matches the participant's latest turn language (detector, not model)                                                                                                                                                                                                                                                      | cassette                                                                                    | live                                                                                                  |
| **Cost and latency**                     | total tokens, cents, p95 turn latency                                                                                                                                                                                                                                                                                                    | n/a                                                                                         | recorded in scorecard                                                                                 |

### 3.4 The deterministic replay layer and the CI gate

- `evals/src/replay.ts` runs a fixture through the real `InterviewEngine`, `updateRollingSummary`, `extractFacts` and `LexicalRecall`, with `ScriptedModel` serving the cassette and the in-memory store from `packages/testing`. Output: a `Scorecard` JSON for that fixture.
- `evals/baselines/replay.json` holds committed per-fixture metric values. A test `evals/src/gate.eval.ts` compares the fresh scorecard to the baseline:
  - exact metrics (coverage, widgets, stopping) must be equal;
  - ratio metrics may not drop by more than `tolerance` (default 0.02) and may not fall below the fixture's floor.
- Improving a metric does not fail, but the PR has to raise the baseline (`pnpm eval:baseline` rewrites the file). A baseline change is a visible diff in review, which is the "merges blocked on regression" mechanism.
- Cassettes pin request hashes (see 3.1). Changing a prompt without re-recording fails with "request hash changed for call 17 (extraction)".
- Run time budget: under 30 s for all 14 fixtures (no network, in-memory).

### 3.5 `eval:live`

`pnpm --filter @aidp/evals eval:live [--template X] [--persona Y] [--max-cents 300] [--record]`.

- **Gate:** exits 0 with a clear "skipped: no API key" message if `EVAL_LIVE_API_KEY`-style env (provider key) is absent. It never fails a contributor's local `pnpm check`. In CI, the nightly job sets the key and treats a skip as a failure (`--require-key`).
- **Cost cap:** `--max-cents` (default 300). The harness wraps the real `ModelCaller` with a ledger-backed `BudgetGuard` (the production class, with a one-off tenant budget). The runner estimates the cost of each fixture up front from the previous scorecard, runs the cheapest-first, and stops with a partial scorecard marked `truncated: true` when the next fixture would exceed the cap. Hard stop on `BudgetExceededError`.
- **Providers:** an `evals/live.config.json` names the provider, the models per purpose, and the judge model (a different model from the one under test).
- **Triggers** (`.github/workflows/evals-live.yml`):
  - `schedule: cron "0 3 * * *"`;
  - `pull_request` with `paths: ["packages/ai/src/**/prompts/**", "packages/ai/src/engine/**", "evals/fixtures/**"]`, as a required check on those paths only;
  - `workflow_dispatch` with inputs for template and cap.
  - The secret is available to same-repo PRs only. Fork PRs are skipped with a clear comment.
- **Output:** writes `docs/evals/scorecards/<date>-<gitsha>.json` plus a regenerated `docs/evals/LATEST.md` (a table and a per-persona delta against the previous run). The nightly job commits these to a `evals-scorecards` branch, and PR runs upload them as an artifact and comment a summary. This keeps the main branch free of noise.
- **Live thresholds** (`evals/thresholds.json`, versioned and reviewed): recall >= 0.85, extraction F1 >= 0.80, issue precision >= 0.70 and recall >= 0.65, spec rubric >= 8/10, widget and stopping 100%. Non-determinism is handled by running each fixture 3 times and gating on the **median**, and on regressions by more than 0.05 against the last 7-night median.

**Scorecard JSON shape:**

```jsonc
{
  "schema": 1,
  "runId": "2026-10-14T03:00:11Z-ab12cd3",
  "git": { "sha": "ab12cd3", "branch": "main", "dirty": false },
  "mode": "live", // replay | live
  "truncated": false,
  "prompts": {
    "interviewer": { "version": 4, "hash": "sha256:..." },
    "extraction": { "version": 1, "hash": "..." },
  },
  "models": { "interview_turn": "provider/model", "judge": "provider/model" },
  "cost": { "cents": 187, "capCents": 300, "tokens": { "in": 0, "out": 0 }, "byPurpose": {} },
  "fixtures": [
    {
      "id": "opportunity_discovery/hostile-nurse",
      "runs": 3,
      "metrics": {
        "coverage": { "pass": true, "curve": [0, 1, 2], "mismatches": [] },
        "factRecall": { "value": 0.88, "gold": 14, "recalled": 12, "missed": ["f_x"] },
        "extraction": { "precision": 0.82, "recall": 0.79, "f1": 0.8, "hallucinated": 1 },
        "issues": { "precision": 0.75, "recall": 0.7, "tp": 6, "fp": 2, "fn": 3 },
        "specRubric": { "score": 9, "of": 10, "failed": ["acceptance_testable"] },
        "widgetPolicy": { "pass": true, "violations": [] },
        "stopping": { "pass": true, "endedAtTurn": 44 },
        "language": { "pass": true },
      },
      "latencyMs": { "p50": 0, "p95": 0 },
      "verdict": "pass",
    },
  ],
  "aggregate": {
    "factRecall": 0.86,
    "extractionF1": 0.81,
    "issuePrecision": 0.74,
    "issueRecall": 0.68,
    "specRubric": 8.7,
  },
  "thresholds": { "factRecall": 0.85 },
  "baseline": { "runId": "...", "delta": { "factRecall": -0.01 } },
  "verdict": "pass",
}
```

### 3.6 Prompt body hash pinned to its version

- `evals/baselines/prompt-hashes.json`: `{ "interviewer@4": "sha256:...", "extraction@1": "..." }` (key = `promptVersionTag`, value = SHA-256 of the normalized body: LF newlines, trailing whitespace trimmed).
- A test in `packages/ai/test/engine/prompt-pins.test.ts` iterates `SHIPPED_PROMPTS`, hashes each body, and:
  - fails if `key@version` exists with a different hash: "prompt changed without a version bump";
  - fails if a shipped `key@version` has no pin: "new prompt version is not pinned";
  - fails if a version number goes down, or a pinned older version's file is deleted (history is append-only; old versions stay in the pin file with `"retired": true`).
- `pnpm eval:pin` rewrites the pin file, so bumping is one command plus the baseline re-record. Order in CI: pin test, then cassette hash check, then replay gate, so the failure message names the first cause.
- The scorecard embeds the hashes, which ties every number to an exact prompt.

### 3.7 Evaluating an admin-edited prompt (`PromptVersion`) before canary

An admin-edited prompt is tenant data, so it cannot ride the repo CI. Design (this is also the "prompt administration UI" gap from the review):

1. **States:** `draft` (new column on `PromptVersion`; today it has only `active` and `canaryShare`) then `evaluated` then `canary` (share > 0) then `active`. `PromptSource` only ever serves `active` rows, as now. A draft is never served.
2. **Gate before canary:** the admin presses "Evaluate". The API enqueues `prompt.evaluate` (new job, tenant payload). The worker runs the **replay-shaped** fixtures for that prompt key through the tenant's own routes and budget, through `ModelCaller` with purpose `eval` (another exempt, capped purpose like `probe`, capped by `cost.evalMaxCentsPerRun`, default 200 cents), substituting the draft body via an in-memory `PromptSource` override.
3. **What runs:** a reduced suite of 4 shared fixtures (cooperative, terse, hostile, language-switching) for the template families the tenant uses, comparing the draft against the currently active version **in the same run** (A/B on the same fixtures, same models, so provider drift cancels out).
4. **Pass criteria:** no deterministic-metric regression (widget policy, stopping, coverage ordering all 100%), and each ratio metric within 0.03 of the incumbent or above the platform floor. Structural checks run first and cost nothing: the placeholders the code substitutes (`{{kinds}}` and others) must be present, the turn-marker contract must be mentioned, and the body must be within length bounds. A prompt without `{{kinds}}` fails before any call.
5. **Result:** stored on the row (`evalScorecard Json`, `evaluatedAt`, `evaluatedBodyHash`). Canary can be enabled only if `evaluatedBodyHash` equals the current body hash and the verdict is `pass`; editing the body clears it. An override flag exists for the operator role only and writes an audit row.
6. **After canary starts:** the existing `canaryShare` mechanism applies, plus an automatic abort if live error rate or `provider_error` rate in the canary arm exceeds the control by a threshold (reads the ledger by `promptVersion`, which is already stamped on every call).

**Effort for section 3:** fixtures and gold labels 4 days (the largest cost, and human), metrics 3 days, replay and cassettes and gate 3 days, `eval:live` and workflows and scorecards 3 days, prompt pins 0.5 day, admin evaluation design plus job (build in M3 after UI exists, otherwise defer) 3 days. About 16 days.

---

## 4. Test coverage program

The current state: `pnpm check` without a DB shows 490 passed and 125 skipped, and 177 DB tests pass when a DB is present. I did not measure line coverage. First step: add `@vitest/coverage-v8` with `--coverage` in CI to produce a baseline, because the targets below are ratchets.

### 4.1 Per-module targets

| Module            | Target (lines / branches)  | Specific tests                                                                                                                                                                  |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared` | 95 / 90                    | property tests (4.3), contract round trips for every zod schema (parse(example) and reject mutated example)                                                                     |
| `packages/ai`     | 90 / 85                    | extraction transaction cases; abort propagation through the adapters; probe purpose; pin test; replay gate                                                                      |
| `packages/core`   | 85 / 80                    | email idempotency; retention GC; jobs consume partial failure; the split requirements services                                                                                  |
| `packages/db`     | 85 / 80                    | scoped client: every `SCOPED_MODELS` model has a cross-tenant test generated from the Prisma DMMF (fails when a new model is missing from `SCOPED_MODELS` or from the RLS list) |
| `apps/worker`     | 90 / 85                    | handler tests (4.2)                                                                                                                                                             |
| `apps/api`        | 85 / 80                    | module tests (4.2b)                                                                                                                                                             |
| `apps/web`        | 70 / 65 lines (components) | component tests (4.4)                                                                                                                                                           |
| `evals`           | 100 on `metrics/`          | each metric function with hand-built cases                                                                                                                                      |

CI fails if a package's coverage drops by more than 0.5 percentage points against `coverage-baseline.json`, and the thresholds above are raised in steps as the program lands.

### 4.2 Worker handler tests with in-memory stores

`apps/worker/test/handlers.test.ts`, using `packages/testing` fakes (`MemorySessionStore`, `ScriptedModel`, `MemoryJobs`, `MemoryEmail`, `MemoryStorage`) and a db handle. Handlers currently take a `PrismaClient`. Introduce small ports where Prisma is used directly (`FactSink` is subsumed by `commitExtraction`; `TokenPruner`) so these tests run without Postgres, with a DB-gated variant for the Prisma adapters.

- `session.extract`: run twice gives identical state and rows; a throw mid-batch (batch 2 of 3) leaves batch 1 durable and a retry finishes; a deleted session is a no-op; `extractorVersion` equals the prompt tag.
- `session.summarize`: twice does one model call; a deleted session is a no-op; the recent-window setting is read from the template then tenant chain.
- `email.send`: twice sends once; the claim-then-crash lease case.
- `privacy.delete-session` and `retention-sweep`: idempotent, tenant-fenced, storage failure then GC recovery.
- `attachment.ingest`: wrong tenant payload is rejected; a missing attachment ends the job without a retry loop.
- `scoped`: a payload with `companyId` runs under `withTenant`; without it, under `withSystemTenant`; two interleaved jobs never see each other's tenant.
- `consume` (in core): batch of 3 with job 2 throwing completes 1 and 3; the payload schema failure goes to `onError`.
- A table-driven test over `Object.keys(JOBS)` asserts each job has a handler, a consumer, an `expireInSeconds` and a retry policy (the "missing consumer" regression from the comment in `main.ts`).

### 4.2b API tests: role matrix and audit rows

One parameterized helper, `describeRoleMatrix(endpoint, expectations)`, that signs in as each of `anonymous | member | admin | platform_operator` plus an admin of a different tenant, and asserts status and (for mutations) the audit row. Per endpoint: the expected statuses, the `AuditLog` row (`action`, `targetType`, `targetId`, `actorId`, and a diff that contains no secrets), and cross-tenant 404.

| Module    | Tests                                                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| campaigns | create/update/archive; link rotation; role matrix; audit; cross-tenant id; `maxTurns` clamp; pagination and filters                                                                                   |
| templates | create/clone/edit/publish; shipped templates read-only; schema rejections; audit; version bump                                                                                                        |
| users     | invite/role change/last-admin guard; email uniqueness across tenants (the finding); role escalation denied; audit                                                                                     |
| audit     | list is tenant-scoped; filters; no mutation endpoints; operator sees cross-tenant only with an explicit scope param                                                                                   |
| operator  | every route denies non-operators (including a tenant admin); suspend/unsuspend (and, after the fix, enforcement); audit for each                                                                      |
| stats     | totals vs seeded ledger rows; tenant isolation; empty tenant; date range; p95 (after the metric lands)                                                                                                |
| providers | secrets masked; `headers` not echoed or audited; test through `ModelCaller` writes a probe ledger row; cross-tenant provider id; SSRF rejection once the guard lands; price and route CRUD with audit |

A generated test walks the OpenAPI document (`openapi.test.ts` already exists) and fails when a route has no entry in the role matrix registry, so a new endpoint cannot ship without declared auth expectations.

### 4.3 `packages/shared` property tests over the settings catalog

With `fast-check`, in `packages/shared/test/settings.property.test.ts`. For every key in `SETTINGS`:

- default parses with its own schema (`schema.safeParse(default).success`);
- type: the schema's inferred kind matches `typeof default`;
- `scopes` is non-empty and a subset of the declared scope enum; `platform` is present unless intentionally excluded (explicit allow-list);
- `category` is a member of a closed `SETTING_CATEGORIES` list and each category has a label in en and fi;
- `description` is non-empty, trimmed, under 140 characters;
- **both locales:** an `apps/web` test asserts `en.settings.descriptions[key]` and `fi.settings.descriptions[key]` exist for every key (today the description lives in the catalog in English only, so the Finnish copy is the gap). Decision: move to i18n keys, keep `description` as the English source, and fail the test when `fi` is missing;
- secrets: `secret: true` keys never appear in `maskSecretSettings` output with a value; the sentinel is rejected as a literal;
- round trip: for each key, a generated valid value passes `schema`, serializes and parses unchanged; generated invalid values (wrong type, out of range) are rejected;
- constraint cross-checks: min <= default <= max for numeric schemas (read from zod's checks), and enum defaults are members.

### 4.4 Web component tests

`@testing-library/react` with `user-event` and `vitest-axe` (jsdom already used: `design-system.test.tsx`, `combobox.test.tsx`).

| Component         | Tests                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TemplateForm`    | required fields; validation errors move focus to the first invalid field (fixes the review finding, written test-first); dirty-guard; coverage-area add/remove/reorder; submit payload equals the API zod schema; axe clean; Finnish render                                                  |
| `ArrivalFlow`     | consent required before start; resume path shows the recap (once built); token expired and deleted-session states; locale switch; keyboard only                                                                                                                                              |
| `InterviewScreen` | SSE stream rendering with a mocked `EventSource`/fetch stream: text deltas, `turn`, `widget`, `ended`, `error`; retry button after `error`; live-region does not double announce (assert on `role="log"` content, written test-first); mode switch roving tabindex; done-confirmation dialog |
| `ResultsView`     | k-anonymity suppression rendering; empty state; sort and filter; chart a11y labels; export buttons disabled until ready                                                                                                                                                                      |

### 4.5 Playwright e2e against the compose dev stack, with a scripted model fake

**Injection design.** No code path changes in production. The platform already has an `openai_compatible` provider kind with a configurable `baseUrl`, so the fake is an HTTP server.

- `tools/fake-model/` (a small workspace package, about 300 lines, no dependencies beyond `node:http`): implements `POST /v1/chat/completions` (streaming SSE and JSON-schema responses), `GET /v1/models`, `POST /v1/embeddings` and `POST /v1/audio/transcriptions`.
- Its brain is the same `ScriptedModel` logic and the cassettes from section 3 (`FAKE_MODEL_SCRIPT=evals/cassettes/...`), plus a default "ideal interviewer" mode. It routes by request shape: a system prompt containing the interviewer marker gets a turn, a JSON-schema request named `extraction` gets facts, and so on, keyed off the prompt keys the platform already sends.
- Controls for failure tests: `X-Fake-Mode` via a control endpoint (`POST /__control {mode: "slow"|"error"|"hang"|"budget"}`), so the e2e suite can test provider failure, the error event and abort.
- `docker-compose.e2e.yml` (an override): adds a `fake-model` service and runs the stack with `E2E_SEED=1`. The seed (`packages/db/src/seeds/e2e.ts`) creates a tenant, an admin, a provider with `baseUrl: http://fake-model:4010/v1` and `kind: openai_compatible`, routes for every purpose, and prices, so the stack needs no secrets and no internet.
- Spec 11 SSRF guard (from the Tier 1 list) will reject private addresses for tenant providers. The e2e seed therefore writes the provider as a **platform-level** provider (operator-owned), which the guard permits, or the guard honours an explicit allow-list env `PROVIDER_ALLOW_HOSTS=fake-model`, set only in the e2e compose override. Decide this when the guard is built; it must not become a hole in production (assert in a test that the env is unset in `docker-compose.yml`).
- `apps/web/e2e/` with `playwright.config.ts`, `webServer` pointing at the running stack (`E2E_BASE_URL`), and sign-in by a test-only email code path read from the mail sink (a `mailpit` service in the override, which the Auth.js SMTP adapter already talks to).

**Journeys (each independent, fresh tenant per test via the seed API):**

1. Admin creates a campaign from a template, copies the link.
2. Participant opens the link, consents, completes a full text interview, sees the summary.
3. Participant uses widgets and the voice-fallback path (typed), then "delete my data" and the link is dead.
4. Admin sees the session, runs analysis, reads the report with k-anonymity.
5. Requirements interview with an invitee, spec generation, version diff, export.
6. Provider failure mid-turn: the error event renders, retry succeeds (fake `error` mode).
7. Client disconnect mid-turn: reload resumes, no duplicate message, lock released.
8. Finnish locale pass (the review's mixed-language finding as a regression test).
9. Two addresses hit the rate limit separately (finding 1).
10. Role boundaries in the UI: a member cannot reach admin pages.

axe runs inside each journey on every distinct page via `@axe-core/playwright` (zero serious or critical violations; the known contrast failures get a tracked, shrinking allow-list).

**Effort:** fake server 2 days, stack override and seeds 1.5, harness and 10 journeys 4, axe 0.5. About 8 days.

### 4.6 Contract tests between web zod schemas and the OpenAPI output

- `openapi.test.ts` already builds the document. Add `apps/web/test/contract.test.ts`: for each response schema the web uses (`apps/web/src/lib/api/*`, `list-schemas.ts`), take its JSON Schema (`z.toJSONSchema`) and verify it is **compatible** with the OpenAPI response schema for the operation: every property the web requires exists as required in the API, and types are equal or narrower. The reverse direction (extra API fields) is allowed.
- Better, remove the duplication: once the envelope and shared contracts live in `packages/shared` (2.5), the web imports the same zod objects the API uses, and the contract test shrinks to "every API response is validated against its schema in e2e/integration" via a Fastify `onSend` hook in tests that parses the payload with the route's declared response schema.
- Add an `openapi.json` snapshot in the repo (`docs/api/openapi.json`) regenerated by `pnpm openapi`; CI fails if the committed file is stale. Breaking changes (removed field, narrowed enum) are flagged by a diff step using `oasdiff`, run in advisory mode first.

### 4.7 Mutation testing and "break it and see"

Use Stryker (`@stryker-mutator/vitest-runner`) scoped, not whole-repo, to keep it affordable: `packages/ai/src/engine`, `packages/ai/src/cost`, `packages/core/src/privacy`, `packages/shared/src/settings.ts`, `packages/db/src/index.ts` (scoped client). Run weekly in CI with `--incremental`; target mutation score >= 75 on those paths, with surviving mutants listed in the job summary. Not a merge gate at first.

**"Break it and see" checklist** for the top 10 behaviours. Each is a deliberate one-line break that a named test must fail on. A script (`pnpm break-it`) applies a patch per item, runs only the named test, asserts it fails, and reverts; run weekly alongside Stryker.

| #   | Behaviour                         | Break                                              | Test that must fail                             |
| --- | --------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| 1   | Tenant fence in the scoped client | remove `a.where = {..., companyId}` for `find*`    | db cross-tenant test, API cross-tenant 404      |
| 2   | RLS                               | drop one table from the policy list                | RLS preflight and the DMMF-driven coverage test |
| 3   | Budget enforcement                | skip `budget.check` in `ModelCaller.chat`          | `callModel.test`, `budget.test`                 |
| 4   | Ledger always written             | remove the `finally` `record`                      | `callModel.test` (error path)                   |
| 5   | Extraction atomicity              | advance `lastExtractedSeq` before rows are written | the failAfter test in 1.1                       |
| 6   | Turn lock                         | drop the `turnLockedAt` condition                  | participant-flow double-submit test             |
| 7   | k-anonymity                       | change `k` check from `>=` to `>` or drop it       | analysis report tests                           |
| 8   | Deletion scope                    | skip `participant`/`invitation` deletion           | privacy e2e                                     |
| 9   | Prompt version pin                | edit a prompt body without a bump                  | the pin test                                    |
| 10  | Rate limit identity               | key by container IP                                | rate-limit e2e with two addresses               |

Section 4 total: about 20 days (4.5 is 8; the API matrix 4; web components 3; worker and others 5).

---

## 5. Quality gates

### 5.1 `pnpm check` after this program

Order is fail-fast, cheapest first.

1. `format:check`: prettier.
2. `lint`: ESLint with the new rules (2.5), including the no-direct-`ctx.db`-in-routes rule and the `as unknown as` ratchet.
3. `typecheck`: `pnpm -r build && pnpm -r typecheck`.
4. `test:unit`: Vitest in all packages with coverage and the network-stub setup file.
5. `test:db`: DB-gated integration (needs `DATABASE_URL`; see 5.3).
6. `eval:replay`: the deterministic eval gate (pins, cassettes, baselines).
7. `audit`: `pnpm audit --prod --audit-level=high` (advisory first, blocking after the dependency upgrades from the status Tier 1).
8. Not in `pnpm check` locally, but in CI: `test:e2e` (Playwright, compose stack) and `a11y` (the axe part runs inside e2e).

### 5.2 CI structure and time budget

| Job                       | Content                                                                 | Budget                | Runs on                  |
| ------------------------- | ----------------------------------------------------------------------- | --------------------- | ------------------------ |
| `static`                  | install, format, lint, typecheck                                        | 4 min                 | every push               |
| `unit`                    | unit tests plus coverage, shard x3                                      | 4 min                 | every push               |
| `db`                      | migrate, integration tests, RLS preflight                               | 6 min                 | every push               |
| `evals-replay`            | pin test, cassettes, gate                                               | 1 min                 | every push               |
| `e2e`                     | compose up with the fake model, Playwright (10 journeys, 2 shards), axe | 12 min                | PRs and main             |
| `audit`                   | pnpm audit, Dependabot                                                  | 1 min                 | every push, plus daily   |
| `evals-live`              | live harness                                                            | 20 min, cap 300 cents | nightly and prompt paths |
| `mutation` and `break-it` | Stryker scoped, break script                                            | 25 min                | weekly                   |

Jobs run in parallel after `static`; the wall-clock budget for a PR is about 15 minutes (`e2e` is the long pole), and local `pnpm check` is under 8 minutes without e2e on a laptop. If `e2e` creeps over 12 minutes, shard further before dropping a journey.

### 5.3 Honest local runs: no silent skips

The status doc shows 125 skipped tests that pass green without `DATABASE_URL`. Fix:

- `scripts/check.ts` (replaces the inline `check` script) parses flags. If `DATABASE_URL` is unset and `--no-db` is not passed, it exits 1 immediately with: `DATABASE_URL is not set. Run "pnpm db:up" or pass --no-db to run without the 177 database-backed tests.`
- With `--no-db` it runs everything else, then prints a **banner** at the end in a non-dismissable summary: `SKIPPED: 177 db tests (--no-db). This result does not satisfy the quality gate.` and exits with code 0 only if the user passed the flag. It writes `.check-state.json` recording `{db: false}`.
- The Vitest DB suites stop using `describe.skipIf(!DATABASE_URL)`. They use a helper `describeDb()` that throws at collection time when `DATABASE_URL` is missing **unless** `AIDP_ALLOW_SKIP_DB=1` (set by `--no-db`). In CI, `AIDP_ALLOW_SKIP_DB` is never set, so a misconfigured job fails instead of skipping.
- A CI assertion step reads the Vitest JSON report and fails if `numPendingTests > 0` for anything not on an explicit allow-list (`skipped-allowlist.txt`, which also ratchets down).
- `pnpm db:up` starts a pgvector container and runs migrations, so the honest path is one command.
- The pre-push hook (simple-git-hooks) runs `pnpm check --no-db` with the banner, and CI is the authority. AGENTS.md rule 7 gets rewritten to match.

**Effort for section 5:** 2.5 days.

---

## 6. Developer experience

### 6.1 One-command offline dev stack

`pnpm dev:offline` (alias for `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`):

- `fake-model` service from 4.5 with the "ideal interviewer" brain; mailpit for email; the Whisper container replaced by the fake `/audio/transcriptions` endpoint (returns a canned transcript), so voice flows work without a model download.
- The `migrate` service runs `prisma migrate deploy` and then the `seed:demo` script. `web` on `localhost:3000`, mailpit UI on `localhost:8025`.
- Zero secrets or internet needed. Dev `.env` values come from `.env.offline` committed to the repo (clearly dev-only keys, with a startup check that refuses to boot with them when `NODE_ENV=production`).
- `pnpm dev:offline:down` and `pnpm dev:reset` (drop volumes, reseed).
- A smoke script, `pnpm dev:smoke`, runs the first Playwright journey against it, which is also what an agent runs to prove the stack works.

### 6.2 Demo seed data

`packages/db/src/seeds/demo.ts`, idempotent (upsert by stable ids), bootstrap-safe (refuses in production unless `--force`):

- Tenant "Demo Hospital", admins in both locales, one member.
- One provider (the fake) with routes for all purposes, prices, and a budget.
- A campaign per template, with 12 completed sessions generated by replaying the fixtures from section 3 through the real engine (so the demo data is the eval data), 3 in progress, one deleted.
- A finished analysis with an opportunity report (k-anonymity visible: one cluster of 2 suppressed), a requirements session with 3 spec versions and findings.
- Shared with the e2e seed (a smaller subset) to avoid two sources of truth.

### 6.3 `docs/CONTRIBUTING.md`

Sections: first run (`pnpm install`, `pnpm dev:offline`, the login URL); repo map (pointing to AGENTS.md for rules rather than duplicating); how to add a setting, a template field, a prompt (bump, `eval:pin`, `eval:record`, expect a baseline diff), a job (definition, handler, consumer is automatic, expiry, idempotency key, tests), an API endpoint (service first, role matrix entry, audit row, OpenAPI), a migration (and the RLS checklist); the test pyramid and which command runs which layer; "definition of done" checklist (maps to the A criteria in section 7); how to read a scorecard; how to run `eval:live` with a key and the cost cap; commit message and requirement-id conventions; the ADR process.

### 6.4 ADRs

AGENTS.md says spec changes go through `docs/discovery/decisions.md` first. Add rows D-81 onward, each linking to a short file in `docs/adr/`:

| Id   | Decision                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------- |
| D-81 | Extraction commits facts and state in one transaction, keyed by (session, batch end seq, ordinal) |
| D-82 | Retention recovers orphaned bytes with a stateless GC pass, not a retry job                       |
| D-83 | Cancellation: AbortSignal on every model call, an `aborted` ledger status                         |
| D-84 | The `probe` and `eval` purposes: pinned, capped, ledgered                                         |
| D-85 | Turn lock heartbeat and TTL; job `expireInSeconds` per definition                                 |
| D-86 | Idempotent email via a claim table                                                                |
| D-87 | Routes hold no tenant queries; services take `companyId` first; `RouteContext` has no `db`        |
| D-88 | `TenantPrismaClient` and `ModelCallerPort`; shared fakes in `packages/testing`                    |
| D-89 | Evals: replay with cassettes plus live scorecards, thresholds, and baselines                      |
| D-90 | Prompt hash pins; admin prompt evaluation before canary                                           |
| D-91 | E2E via an `openai_compatible` fake server; no production injection point                         |
| D-92 | `pnpm check` fails loudly without a DB unless `--no-db`                                           |

ADR format: Context, Decision, Consequences, Requirement ids, Status. `decisions.md` rows carry the one-line decision and the link.

Section 6 total: about 4 days (fake server counted in 4.5).

---

## 7. Milestone plan

Effort is in working days for one engineer or agent. Dependencies are listed explicitly.

### M1: Correctness and gates (about 15 days)

| Item                                                                                                  | Files (main)                                                                                                  | Days | Depends on                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------- |
| Extraction transaction + migration 0013                                                               | `ai/engine/extraction.ts`, `ports.ts`, `core/sessions` store, `worker/handlers.ts`, `db/prisma/schema.prisma` | 1.5  | none                            |
| `packages/testing` fakes + `ModelCallerPort` (2.7)                                                    | new package, `ai/callModel.ts`, `evals/src/*`                                                                 | 1.5  | none (do first; unblocks tests) |
| Worker handler tests                                                                                  | `worker/test/handlers.test.ts`                                                                                | 2    | fakes, extraction               |
| Batch parallelism + shutdown + `expireInSeconds`                                                      | `core/jobs/*`, `worker/main.ts`, compose                                                                      | 2    | none                            |
| Retention GC                                                                                          | `core/privacy/retention.ts`, `core/storage/*`                                                                 | 1.5  | storage fake                    |
| AbortSignal, SSE error handling, lock heartbeat                                                       | `ai/providers/*`, `callModel.ts`, `turn-runner.ts`, `voice-live.ts`                                           | 3    | `ModelCallerPort`               |
| `probe` purpose                                                                                       | `shared/purposes.ts`, `callModel.ts`, `providers/service.ts`                                                  | 1.5  | abort work                      |
| Email idempotency                                                                                     | `core/email`, `worker`, schema                                                                                | 1    | migration batching with 0013    |
| Prompt version from object + dead prompt deletion + pin test                                          | `prompts/*`, `worker`, pin file                                                                               | 0.75 | none                            |
| Gates: `scripts/check.ts`, `describeDb`, coverage baseline, network stub, CI split, `pnpm audit` step | root `package.json`, `.github/workflows/ci.yml`, vitest setups                                                | 2.5  | none                            |

**Acceptance for M1:**

- Every item in section 1 has tests that failed before the fix.
- `pnpm check` fails without `DATABASE_URL` unless `--no-db`, and CI reports zero skipped tests.
- Tests cannot reach the network (verified by a canary test that tries and expects the throw).
- Break-it items 3 to 6 and 9 fail the named tests.

### M2: Architecture (about 12 days)

| Item                                                                                          | Days | Depends on                             |
| --------------------------------------------------------------------------------------------- | ---- | -------------------------------------- |
| Services for the 11 route modules, `RouteContext` without `db`, cross-tenant tests per module | 5    | M1 fakes                               |
| `TenantPrismaClient`, cast removal, ratchet                                                   | 1    | with the above                         |
| ESLint `no-restricted-imports` / `no-restricted-globals` rules, ratchet allow-lists           | 1    | services moved (rule 4 half)           |
| Split `requirements/service.ts`                                                               | 2    | none                                   |
| Split `voice-live.ts`                                                                         | 2.5  | abort work from M1                     |
| Split `useLiveVoice.ts`                                                                       | 2.5  | none                                   |
| `PageQuery` + `listOf` to `packages/shared`                                                   | 0.75 | none                                   |
| API role matrix and audit-row tests (4.2b)                                                    | 4    | services (write tests as modules move) |

M2 totals about 19 days of work if counted individually; run the three splits and the services in parallel across two workers to hit about 12 elapsed days, or accept about 19 with one.

**Acceptance for M2:**

- No `routes.ts` touches Prisma (lint-enforced).
- No file over 500 lines in the three split areas.
- Zero `as unknown as` or `as PrismaClient` outside a named allow-list of under 5 entries, each with a reason.
- Lint rules 2 and 5 are active with zero violations.
- The role-matrix registry covers 100% of OpenAPI operations.

### M3: Evals and e2e (about 24 days)

| Item                                                                        | Days | Depends on                                                                    |
| --------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| Fixture schema, generator tool, 14 fixtures with gold labels (human review) | 4    | none                                                                          |
| Metrics library + unit tests                                                | 3    | fixture schema                                                                |
| Replay layer, cassettes, baselines, gate                                    | 3    | metrics, M1 fakes                                                             |
| Fake model server                                                           | 2    | cassette format                                                               |
| Compose override, e2e seed, demo seed, `dev:offline`                        | 2.5  | fake server                                                                   |
| Playwright harness, 10 journeys, axe                                        | 4.5  | stack                                                                         |
| `eval:live`, cost cap, scorecards, workflows                                | 3    | metrics, `eval` budget cap                                                    |
| Web component tests (4.4) and settings property tests (4.3)                 | 3    | none                                                                          |
| Contract tests + OpenAPI snapshot                                           | 1    | `PageQuery` move                                                              |
| Admin prompt evaluation (design implemented with the prompt admin UI)       | 3    | prompt UI from Tier 3 of the review; schedule after, or cut from this program |
| Stryker + break-it script                                                   | 1.5  | tests in place                                                                |
| CONTRIBUTING.md and ADRs D-81 to D-92                                       | 1.5  | written alongside; finalize at end                                            |

**Acceptance for M3:**

- A 60-turn replay of all 14 fixtures runs in CI in under 30 s and fails on a deliberately broken prompt or assembler.
- One live nightly run has produced a committed scorecard that meets `thresholds.json`, with the cost under the cap.
- `pnpm dev:offline` takes a new engineer from clone to a completed interview, with no keys, in under 10 minutes (timed in `dev:smoke`).

Total across the three milestones: about 50 elapsed days for one engineer, about 35 with two working in parallel on M2 and M3 after the M1 fakes land.

### What "engineering A" means (measurable)

1. **Correctness:** no known data-loss or double-processing path; every job is idempotent and proven by a twice-run test; cancellation and lock behaviour are tested.
2. **Structure:** rules 2, 4 and 5 are enforced by the compiler or lint rather than by review; no god files over 500 lines; no unscoped Prisma access outside `packages/db`, the operator service and the system-tenant jobs.
3. **Tests:** no silent skips anywhere; coverage at or above the section 4.1 targets with a ratchet; the mutation score at least 75% on the critical paths; the break-it table passes weekly.
4. **Evals:** NFR-06 is met literally. There are 60-turn fixtures for every persona on both templates, the metrics are tested, the replay gate blocks regressions, a nightly live scorecard is published in `docs/evals/`, every prompt is hash-pinned to its version, and an admin prompt cannot reach canary unevaluated.
5. **Delivery:** one `pnpm check` that cannot lie, a CI that runs e2e with axe on the real stack in about 15 minutes, a daily audit, and an offline one-command dev stack with demo data.
6. **Documentation:** CONTRIBUTING.md and ADRs D-81 to D-92 referenced from `docs/discovery/decisions.md`.

### Risks and open decisions for the owner

- **Fixture labelling is human work** and caps the value of every metric. I recommend funding the 4 days and having the domain owner review the gold facts for at least the first two fixtures per template.
- **pg-boss per-job completion API** (1.8) must be confirmed against the installed version before I commit to the partial-failure design. A fallback is one job per `work()` call with `batchSize: 1` and N consumers, which is simpler and just as parallel.
- **SSRF guard versus the e2e fake** (4.5): needs to be decided together with Tier 1 item 4, as described there.
- **Where prompt evaluation runs for tenants** (3.7) depends on whether the prompt admin UI is in this program. If not, ship only the repo-side pins and defer the rest.
- **Ordering with the Tier 1 pilot blockers** in the status doc: M1 overlaps Tier 1 (alerts, outbound timeouts, SSRF). I recommend doing Tier 1 first, since the outbound-timeout work and the abort work in 1.3 touch the same adapter code, and the abort change should absorb the timeout fix rather than land twice.
- I counted route queries by grep, not by running anything. Treat the per-module numbers in 2.1 as call sites (they are slightly different from raw `ctx.db` line counts, which were providers 17, operator 12, analysis 11, campaigns 10, stats 9, users 9, settings 8, requirements 7).
