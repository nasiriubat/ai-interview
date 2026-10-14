#!/usr/bin/env node
// Generates the Grafana dashboards in ./dashboards from the definitions below (D-222).
//
//   node infra/observability/grafana/build-dashboards.mjs          # write the JSON files
//   node infra/observability/grafana/build-dashboards.mjs --check  # fail if they are out of date
//
// The JSON is checked in, because Grafana provisions from files and a dashboard that exists only
// as the output of a script is not something an operator can read on a host. The definitions are
// here, in a form that fits on a screen, because hand-editing 3000 lines of panel JSON is how a
// dashboard ends up asking for a series that no longer exists. packages/core/test/observability
// holds the two to each other: the files must equal what this builds, and every `aidp_*` series a
// panel names must be one the application exports.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DS = { type: "prometheus", uid: "prometheus" };

let nextId = 1;
const target = (expr, legend, refId = "A") => ({
  datasource: DS,
  expr,
  legendFormat: legend ?? "",
  refId,
  range: true,
});

const base = (title, type, x, y, w, h, extra) => ({
  id: nextId++,
  title,
  type,
  datasource: DS,
  gridPos: { x, y, w, h },
  ...extra,
});

/** A single number with colour thresholds: `steps` are [value, colour] from the first above base. */
function stat(title, expr, pos, { unit = "short", steps = [], description = "", decimals } = {}) {
  return base(title, "stat", ...pos, {
    description,
    targets: [target(expr)],
    fieldConfig: {
      defaults: {
        unit,
        ...(decimals === undefined ? {} : { decimals }),
        thresholds: {
          mode: "absolute",
          steps: [{ color: "green", value: null }, ...steps.map(([value, color]) => ({ color, value }))],
        },
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ["lastNotNull"], fields: "", values: false },
      colorMode: "background",
      graphMode: "area",
      textMode: "auto",
    },
  });
}

/** A time series with one or more queries; `lines` are [expr, legend]. */
function series(title, lines, pos, { unit = "short", description = "", stack = false, thresholdAt } = {}) {
  return base(title, "timeseries", ...pos, {
    description,
    targets: lines.map(([expr, legend], i) => target(expr, legend, String.fromCharCode(65 + i))),
    fieldConfig: {
      defaults: {
        unit,
        custom: {
          lineWidth: 1,
          fillOpacity: stack ? 30 : 8,
          stacking: { mode: stack ? "normal" : "none", group: "A" },
          showPoints: "never",
          ...(thresholdAt === undefined ? {} : { thresholdsStyle: { mode: "line" } }),
        },
        ...(thresholdAt === undefined
          ? {}
          : {
              thresholds: {
                mode: "absolute",
                steps: [
                  { color: "green", value: null },
                  { color: "red", value: thresholdAt },
                ],
              },
            }),
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: "table", placement: "bottom", calcs: ["lastNotNull", "max"] },
      tooltip: { mode: "multi", sort: "desc" },
    },
  });
}

const row = (title, y) => base(title, "row", 0, y, 24, 1, { collapsed: false, panels: [] });

function dashboard(uid, title, description, panels) {
  return {
    uid,
    title,
    description,
    tags: ["aidp"],
    timezone: "utc",
    schemaVersion: 39,
    version: 1,
    editable: false,
    refresh: "30s",
    time: { from: "now-6h", to: "now" },
    templating: {
      list: [
        {
          name: "tenant",
          label: "Tenant",
          type: "query",
          datasource: DS,
          query: { query: "label_values(aidp_model_tokens_total, tenant)", refId: "tenant" },
          refresh: 2,
          includeAll: true,
          allValue: ".*",
          multi: true,
          current: { selected: true, text: "All", value: "$__all" },
        },
      ],
    },
    annotations: { list: [] },
    links: [{ title: "Overview", type: "link", url: "/d/aidp-overview", tags: [], targetBlank: false }],
    panels,
  };
}

// Interview turns: the purposes a participant waits on.
const TURN = 'purpose=~"interview_turn|spec_turn"';
const FIRST_TOKEN = `aidp_turn_first_token_seconds_bucket{${TURN},tenant=~"$tenant"}`;

export function buildDashboards() {
  nextId = 1;
  const out = {};

  out["overview.json"] = dashboard(
    "aidp-overview",
    "Overview and SLOs",
    "The signals an operator opens in the morning. Targets: first token p95 under 2 s (NFR-01), voice first word p95 under 1.5 s, job success at or above 99.5 percent, a verified backup less than a week old.",
    [
      row("Service level objectives", 0),
      stat(
        "First token p95 (NFR-01, target < 2 s)",
        `histogram_quantile(0.95, sum by (le) (rate(aidp_turn_first_token_seconds_bucket{${TURN}}[$__range])))`,
        [0, 1, 6, 5],
        {
          unit: "s",
          steps: [[2, "red"]],
          description:
            "Time from the request to the first streamed token of an interview or specification turn, over the selected range.",
        },
      ),
      stat(
        "Voice first word p95 (target < 1.5 s)",
        "histogram_quantile(0.95, sum by (le) (rate(aidp_voice_first_word_seconds_bucket[$__range])))",
        [6, 1, 6, 5],
        {
          unit: "s",
          steps: [[1.5, "red"]],
          description: "Question asked to first audible word, live voice.",
        },
      ),
      stat(
        "Model call error rate",
        "sum(rate(aidp_provider_errors_total[$__range])) / clamp_min(sum(rate(aidp_model_call_duration_seconds_count[$__range])), 1e-9)",
        [12, 1, 6, 5],
        {
          unit: "percentunit",
          steps: [
            [0.05, "orange"],
            [0.15, "red"],
          ],
          decimals: 1,
        },
      ),
      stat("Oldest job waiting (queue age)", "max(aidp_jobs_oldest_queued_age_seconds)", [18, 1, 6, 5], {
        unit: "s",
        steps: [
          [300, "orange"],
          [900, "red"],
        ],
        description:
          "Age of the oldest queued job across every queue; the sweep runs every five minutes, so a healthy number is under a few minutes.",
      }),
      row("Platform", 6),
      stat("Jobs queued", "sum(aidp_jobs_queued)", [0, 7, 4, 4], {
        steps: [
          [50, "orange"],
          [200, "red"],
        ],
      }),
      stat("Dead letters", "sum(aidp_jobs_dead_lettered)", [4, 7, 4, 4], { steps: [[1, "red"]] }),
      stat("Backup age", "time() - aidp_backup_last_success_timestamp_seconds", [8, 7, 4, 4], {
        unit: "s",
        steps: [[93600, "red"]],
        description: "Seconds since the last successful backup; 26 hours is the alert threshold.",
      }),
      stat("Restore drill age", "time() - aidp_restore_drill_last_success_timestamp_seconds", [12, 7, 4, 4], {
        unit: "s",
        steps: [
          [777600, "orange"],
          [1209600, "red"],
        ],
        description: "Seconds since a weekly restore drill last matched its manifest.",
      }),
      stat("Worker heartbeat age", "aidp_worker_heartbeat_age_seconds", [16, 7, 4, 4], {
        unit: "s",
        steps: [
          [90, "orange"],
          [300, "red"],
        ],
      }),
      stat("Disk used", "max(aidp_disk_used_ratio)", [20, 7, 4, 4], {
        unit: "percentunit",
        steps: [
          [0.8, "orange"],
          [0.9, "red"],
        ],
      }),
      row("Traffic", 11),
      series(
        "Active interviews by tenant",
        [['sum by (tenant) (aidp_sessions_active{tenant=~"$tenant"})', "{{tenant}}"]],
        [0, 12, 12, 7],
        { stack: true },
      ),
      series(
        "Job queues",
        [
          ["sum by (queue) (aidp_jobs_queued)", "queued {{queue}}"],
          ["sum by (queue) (aidp_jobs_active)", "active {{queue}}"],
        ],
        [12, 12, 12, 7],
      ),
      series(
        "First token p95 against the 2 s target",
        [[`histogram_quantile(0.95, sum by (le) (rate(${FIRST_TOKEN}[5m])))`, "p95"]],
        [0, 19, 12, 7],
        { unit: "s", thresholdAt: 2 },
      ),
      series(
        "Circuit breaker state (0 closed, 1 half open, 2 open)",
        [["aidp_provider_circuit_state", "{{provider}}"]],
        [12, 19, 12, 7],
      ),
    ],
  );

  out["interview-latency.json"] = dashboard(
    "aidp-latency",
    "Interview latency",
    "First token and turn duration by provider and model, with error and refusal rates and the cache hit ratio.",
    [
      series(
        "First token p50 / p95 / p99",
        [
          [`histogram_quantile(0.5, sum by (le) (rate(${FIRST_TOKEN}[5m])))`, "p50"],
          [`histogram_quantile(0.95, sum by (le) (rate(${FIRST_TOKEN}[5m])))`, "p95"],
          [`histogram_quantile(0.99, sum by (le) (rate(${FIRST_TOKEN}[5m])))`, "p99"],
        ],
        [0, 0, 12, 8],
        { unit: "s", thresholdAt: 2 },
      ),
      series(
        "First token p95 by provider and model",
        [
          [
            `histogram_quantile(0.95, sum by (le, provider, model) (rate(${FIRST_TOKEN}[5m])))`,
            "{{provider}} {{model}}",
          ],
        ],
        [12, 0, 12, 8],
        { unit: "s", thresholdAt: 2 },
      ),
      series(
        "Turn duration p95 by mode",
        [
          [
            'histogram_quantile(0.95, sum by (le, mode) (rate(aidp_turn_duration_seconds_bucket{tenant=~"$tenant"}[5m])))',
            "{{mode}}",
          ],
        ],
        [0, 8, 12, 8],
        { unit: "s" },
      ),
      series(
        "Model call duration p95 by purpose",
        [
          [
            "histogram_quantile(0.95, sum by (le, purpose) (rate(aidp_model_call_duration_seconds_bucket[5m])))",
            "{{purpose}}",
          ],
        ],
        [12, 8, 12, 8],
        { unit: "s" },
      ),
      series(
        "Failed model calls per minute by provider",
        [["sum by (provider, code) (rate(aidp_provider_errors_total[5m])) * 60", "{{provider}} {{code}}"]],
        [0, 16, 12, 8],
        { stack: true },
      ),
      series(
        "Prompt cache hit ratio",
        [
          [
            'sum(rate(aidp_model_tokens_total{kind="cache_read",tenant=~"$tenant"}[15m])) / clamp_min(sum(rate(aidp_model_tokens_total{kind=~"input|cache_read",tenant=~"$tenant"}[15m])), 1e-9)',
            "cache read / input",
          ],
        ],
        [12, 16, 12, 8],
        { unit: "percentunit" },
      ),
      series(
        "Calls blocked by a budget",
        [['sum by (scope) (increase(aidp_budget_blocked_total{tenant=~"$tenant"}[1h]))', "{{scope}}"]],
        [0, 24, 12, 7],
      ),
      series(
        "HTTP request duration p95 by route",
        [
          [
            "histogram_quantile(0.95, sum by (le, route) (rate(aidp_http_request_duration_seconds_bucket[5m])))",
            "{{route}}",
          ],
        ],
        [12, 24, 12, 7],
        { unit: "s" },
      ),
    ],
  );

  out["voice.json"] = dashboard(
    "aidp-voice",
    "Live voice",
    "Question to first word, speech to first caption, interruptions and fallbacks, and audio sent to transcription.",
    [
      series(
        "First word p50 / p95 (target p95 < 1.5 s)",
        [
          [
            'histogram_quantile(0.5, sum by (le) (rate(aidp_voice_first_word_seconds_bucket{tenant=~"$tenant"}[15m])))',
            "p50",
          ],
          [
            'histogram_quantile(0.95, sum by (le) (rate(aidp_voice_first_word_seconds_bucket{tenant=~"$tenant"}[15m])))',
            "p95",
          ],
        ],
        [0, 0, 12, 8],
        { unit: "s", thresholdAt: 1.5 },
      ),
      series(
        "First caption p95 (streaming mode)",
        [
          [
            'histogram_quantile(0.95, sum by (le, mode) (rate(aidp_voice_first_partial_seconds_bucket{tenant=~"$tenant"}[15m])))',
            "{{mode}}",
          ],
        ],
        [12, 0, 12, 8],
        { unit: "s", thresholdAt: 1 },
      ),
      series(
        "Interruptions per hour",
        [
          [
            'sum(increase(aidp_voice_events_total{event="interruption",tenant=~"$tenant"}[1h]))',
            "interruptions",
          ],
        ],
        [0, 8, 12, 7],
      ),
      series(
        "Stream fallbacks per hour",
        [
          [
            'sum(increase(aidp_voice_events_total{event="stream_fallback",tenant=~"$tenant"}[1h]))',
            "fallbacks",
          ],
        ],
        [12, 8, 12, 7],
      ),
      series(
        "Audio sent to transcription (seconds per hour) by tenant",
        [['sum by (tenant) (increase(aidp_voice_audio_seconds_total{tenant=~"$tenant"}[1h]))', "{{tenant}}"]],
        [0, 15, 12, 8],
        { stack: true },
      ),
      series(
        "On-server speech model state (0 absent, 1 loading, 2 ready, 3 failed)",
        [["aidp_speech_model_state", "state"]],
        [12, 15, 12, 8],
      ),
    ],
  );

  out["jobs.json"] = dashboard(
    "aidp-jobs",
    "Background jobs",
    "Queue depth, dead letters, duration and failures per queue.",
    [
      series(
        "Queued, active and dead-lettered by queue",
        [
          ["aidp_jobs_queued", "queued {{queue}}"],
          ["aidp_jobs_active", "active {{queue}}"],
          ["aidp_jobs_dead_lettered", "dead {{queue}}"],
        ],
        [0, 0, 12, 8],
      ),
      series(
        "Oldest queued job age by queue",
        [["aidp_jobs_oldest_queued_age_seconds", "{{queue}}"]],
        [12, 0, 12, 8],
        { unit: "s", thresholdAt: 900 },
      ),
      series(
        "Job duration p95 by job",
        [
          [
            'histogram_quantile(0.95, sum by (le, name) (rate(aidp_job_duration_seconds_bucket{outcome="ok"}[15m])))',
            "{{name}}",
          ],
        ],
        [0, 8, 12, 8],
        { unit: "s" },
      ),
      series(
        "Failed attempts per hour by job",
        [["sum by (name, final) (increase(aidp_job_failures_total[1h]))", "{{name}} final={{final}}"]],
        [12, 8, 12, 8],
        { stack: true },
      ),
      stat(
        "Job success, 7 d (target >= 99.5 %)",
        '1 - (sum(increase(aidp_job_failures_total{final="true"}[7d])) / clamp_min(sum(increase(aidp_job_duration_seconds_count[7d])), 1))',
        [0, 16, 8, 5],
        { unit: "percentunit", decimals: 2, steps: [] },
      ),
    ],
  );

  out["cost.json"] = dashboard(
    "aidp-cost",
    "Cost",
    "Spend in cents by tenant, purpose and provider, and tokens per hour. Budget lines are on the operator health page and in /spend/budgets.",
    [
      series(
        "Cents per hour by tenant",
        [
          [
            'sum by (tenant) (rate(aidp_model_cost_cents_total{tenant=~"$tenant"}[15m])) * 3600',
            "{{tenant}}",
          ],
        ],
        [0, 0, 12, 8],
        { stack: true },
      ),
      series(
        "Cents per hour by purpose",
        [
          [
            'sum by (purpose) (rate(aidp_model_cost_cents_total{tenant=~"$tenant"}[15m])) * 3600',
            "{{purpose}}",
          ],
        ],
        [12, 0, 12, 8],
        { stack: true },
      ),
      series(
        "Cents per hour by provider",
        [
          [
            'sum by (provider) (rate(aidp_model_cost_cents_total{tenant=~"$tenant"}[15m])) * 3600',
            "{{provider}}",
          ],
        ],
        [0, 8, 12, 8],
        { stack: true },
      ),
      series(
        "Tokens per hour by kind",
        [['sum by (kind) (rate(aidp_model_tokens_total{tenant=~"$tenant"}[15m])) * 3600', "{{kind}}"]],
        [12, 8, 12, 8],
        { stack: true },
      ),
      stat(
        "Cents, last 24 h",
        'sum(increase(aidp_model_cost_cents_total{tenant=~"$tenant"}[24h]))',
        [0, 16, 6, 5],
        { decimals: 1 },
      ),
      series(
        "Stored attachment bytes by tenant",
        [['sum by (tenant) (aidp_storage_bytes{tenant=~"$tenant"})', "{{tenant}}"]],
        [6, 16, 18, 7],
        { unit: "bytes" },
      ),
    ],
  );

  out["host-and-backups.json"] = dashboard(
    "aidp-host",
    "Host and backups",
    "Process memory, disk, and the backup and restore-drill evidence.",
    [
      series(
        "Process resident memory",
        [["aidp_process_resident_memory_bytes", "{{service}}"]],
        [0, 0, 12, 8],
        { unit: "bytes" },
      ),
      series("Process heap in use", [["aidp_process_heap_used_bytes", "{{service}}"]], [12, 0, 12, 8], {
        unit: "bytes",
      }),
      series("Disk used", [["aidp_disk_used_ratio", "{{mount}}"]], [0, 8, 12, 7], {
        unit: "percentunit",
        thresholdAt: 0.9,
      }),
      series("Size of the last backup", [["aidp_backup_last_size_bytes", "dump"]], [12, 8, 12, 7], {
        unit: "bytes",
      }),
      stat("Age of the last backup", "time() - aidp_backup_last_success_timestamp_seconds", [0, 15, 6, 5], {
        unit: "s",
        steps: [[93600, "red"]],
      }),
      stat(
        "Age of the last offsite copy",
        "time() - aidp_backup_offsite_last_success_timestamp_seconds",
        [6, 15, 6, 5],
        { unit: "s", steps: [[93600, "red"]] },
      ),
      stat(
        "Age of the last restore drill",
        "time() - aidp_restore_drill_last_success_timestamp_seconds",
        [12, 15, 6, 5],
        {
          unit: "s",
          steps: [
            [777600, "orange"],
            [1209600, "red"],
          ],
        },
      ),
      stat("Worker heartbeat age", "aidp_worker_heartbeat_age_seconds", [18, 15, 6, 5], {
        unit: "s",
        steps: [
          [90, "orange"],
          [300, "red"],
        ],
      }),
    ],
  );

  return out;
}

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "dashboards");

/**
 * The file text for one dashboard: JSON formatted by the repository's own prettier, so that what is
 * written is what `prettier --check` accepts and `--check` here compares byte for byte.
 */
export async function render(obj, path) {
  const text = `${JSON.stringify(obj, null, 2)}\n`;
  const prettier = await import("prettier");
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(text, { ...config, parser: "json" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const built = buildDashboards();
  let stale = 0;
  if (!check) mkdirSync(dir, { recursive: true });
  for (const [file, obj] of Object.entries(built)) {
    const path = join(dir, file);
    const text = await render(obj, path);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
        console.error(`out of date: ${path}`);
        stale++;
      }
    } else {
      writeFileSync(path, text);
      console.log(`wrote ${path}`);
    }
  }
  process.exit(stale === 0 ? 0 : 1);
}
