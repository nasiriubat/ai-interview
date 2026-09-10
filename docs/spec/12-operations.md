# 12 Operations and production readiness

- Tracing with OpenTelemetry: session, turn, model call, job, tokens, cost, latency in one trace. Exported to Grafana Tempo by default (self-hosted stack in `infra/`), or any OTLP backend.
- Structured logs with request, tenant, session ids; metrics with SLOs: first token under 2 s at p95 (NFR-01), voice first word under 1.5 s at p95, job success rate above 99.5 percent, budget-block rate visible.
- Replayable event log: any session re-runs offline against a new prompt version.
- Evals in CI on fixed transcripts: coverage progression, fact recall after summary, issue detection precision, specification completeness, extraction accuracy. Merges blocked on regression (NFR-06).
- Jobs: idempotent, exponential backoff, dead-letter queue, admin retry view (NFR-09).
- Typed contracts; generated API client for the frontend; migrations reviewed and reversible.
- Feature flags per tenant; prompt version canaries; instant rollback.
- Load tests before each phase ships; chaos test for provider outage: the interview pauses politely and resumes.
- Backups: nightly Postgres and object storage snapshots, restore drill each phase.
- Deployment: Docker Compose with health checks; blue-green by service; migrations run before rollout.
- Cache-hit test (NFR-08) and cost regression test per prompt change.
