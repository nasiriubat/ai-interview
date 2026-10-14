# Observability

An optional layer for the production stack (D-222): Prometheus and Grafana, with provisioned
dashboards and the service level objectives drawn on them, and Tempo for traces behind a second
profile. Nothing in the stack needs it. Without it the operator still has the alerts
(`docs/OPERATIONS.md`), `GET /stats` (first-token p95 and voice signals) and the operator health page
(`GET /operator/health`, Operator → Platform health). This is for looking at distributions over time.

## Bring it up

```bash
# 1. a password for Grafana, in .env
echo 'GRAFANA_ADMIN_PASSWORD=<something long>' >> .env

# 2. metrics and dashboards
deploy/dc -f deploy/observability/compose.yml --profile observability up -d

# 3. optional: traces (8 GB hosts; see sizing). Also set, in .env,
#    OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318   and   deploy/dc up -d api worker
deploy/dc -f deploy/observability/compose.yml --profile observability --profile traces up -d
```

Grafana listens on the host's loopback only. From your laptop:

```bash
ssh -L 3001:localhost:3001 you@your-vps     # then http://localhost:3001, user admin
```

The `api` and `worker` services expose their metrics on `9464` and `9465` on the compose network
and nowhere else; Caddy has no route to them.

## What is in it

| File                        | What                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| `compose.yml`               | Prometheus (192 MB), Grafana (224 MB), Tempo (192 MB, `traces` profile). Layered, not merged. |
| `prometheus/prometheus.yml` | Scrapes `api:9464` and `worker:9465` every 15 s. 15 days or 1 GB of data, whichever is first. |
| `prometheus/rules.yml`      | Recording rules for the SLO panels (p95s, error ratio, error-budget burn).                    |
| `grafana/dashboards/*.json` | Six dashboards, provisioned read-only. Generated, and checked in (below).                     |
| `grafana/provisioning/`     | The Prometheus and Tempo data sources, and where the dashboards are loaded from.              |
| `tempo/tempo.yml`           | Single binary, local storage, OTLP over HTTP on 4318, seven days.                             |

### Dashboards

| Dashboard         | Answers                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| Overview and SLOs | Are the objectives met (below), what is queued, dead-lettered, how old are the backup and the drill?  |
| Interview latency | First token p50/p95/p99 by provider and model, turn duration, errors, cache hit ratio, budget blocks. |
| Live voice        | Question to first word, speech to first caption, interruptions, stream fallbacks, audio sent.         |
| Background jobs   | Depth, oldest age, duration, failures per queue.                                                      |
| Cost              | Cents per hour by tenant, purpose and provider; tokens; stored bytes.                                 |
| Host and backups  | Process memory, disk, backup size and age, offsite age, restore-drill age, worker heartbeat.          |

### Objectives

| Objective             | Target                                            | Series                                                                                            |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| First token (NFR-01)  | p95 under 2.0 s                                   | `aidp_turn_first_token_seconds` (interview and spec turns)                                        |
| Voice first word      | p95 under 1.5 s (`voice.targetFirstWordMs`)       | `aidp_voice_first_word_seconds`                                                                   |
| Model call error rate | under 5 % (orange), 15 % (red)                    | `aidp_provider_errors_total`, `aidp_model_call_duration_seconds_count`                            |
| Queue age             | oldest job under 5 minutes (orange), 15 (red)     | `aidp_jobs_oldest_queued_age_seconds`                                                             |
| Job success           | at or above 99.5 % over 7 days                    | `aidp_job_failures_total{final="true"}`                                                           |
| Backup freshness      | a backup under 26 h, a verified restore under 9 d | `aidp_backup_last_success_timestamp_seconds`, `aidp_restore_drill_last_success_timestamp_seconds` |

These are the same thresholds the application alerts on and the operator health page shows;
a dashboard is where you look at them over a week, not a second source of truth.

## Changing a dashboard

The JSON is what Grafana reads, so it is checked in. It is generated from compact definitions:

```bash
$EDITOR deploy/observability/grafana/build-dashboards.mjs
node deploy/observability/grafana/build-dashboards.mjs            # rewrites the JSON
node deploy/observability/grafana/build-dashboards.mjs --check    # CI: fails if it is out of date
```

`packages/core/test/observability.test.ts` fails when the files differ from what the generator
builds, and when a panel or a rule names an `aidp_*` series the application does not export, which
is how a dashboard quietly goes blank after a metric is renamed.

## Sizing

| Host | Stack limits (`deploy/compose.yml`) | `observability` | `traces` | Verdict                                                                                                 |
| ---- | ----------------------------------- | --------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| 4 GB | about 3.2 GB                        | +416 MB         | +192 MB  | metrics profile fits with about 450 MB left for the OS; leave traces off, or use a hosted OTLP endpoint |
| 8 GB | about 7.6 GB with the 8 GB preset   | +416 MB         | +192 MB  | both fit                                                                                                |

Limits are ceilings, not reservations. Prometheus at one scrape target pair and a pilot's label
cardinality (one `tenant` label, ten tenants) holds well under its limit; the retention cap of
1 GB is what bounds the disk.

A hosted alternative for traces on a 4 GB host: point `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP
receiver (Grafana Cloud's free tier, for one). The exporter is OTLP over HTTP, so nothing here is
specific to Tempo.
