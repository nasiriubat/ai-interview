import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PromMetrics } from "../src/telemetry/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const obs = join(root, "deploy", "observability");
const dashboardsDir = join(obs, "grafana", "dashboards");

interface Panel {
  id: number;
  title: string;
  type: string;
  datasource?: { uid: string };
  targets?: { expr: string }[];
}
interface Dashboard {
  uid: string;
  title: string;
  panels: Panel[];
}

const generator = (await import(pathToFileURL(join(obs, "grafana", "build-dashboards.mjs")).href)) as {
  buildDashboards: () => Record<string, Dashboard>;
  render: (obj: unknown, path: string) => Promise<string>;
};

const SERIES = /\baidp_[a-z0-9_]+/g;
const base = (name: string): string => name.replace(/_(bucket|sum|count)$/, "");

/** The metric names the application registers, once each. */
const exported = new Set(new PromMetrics().registry.names());

describe("deploy/observability (D-222)", () => {
  const built = generator.buildDashboards();

  it("checks in exactly the dashboards the generator builds", async () => {
    const onDisk = readdirSync(dashboardsDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    expect(onDisk).toEqual(Object.keys(built).sort());
    for (const [file, obj] of Object.entries(built)) {
      const path = join(dashboardsDir, file);
      expect(readFileSync(path, "utf8"), `${file} is out of date: run build-dashboards.mjs`).toBe(
        await generator.render(obj, path),
      );
    }
  });

  it("asks only for series the application exports", () => {
    const wanted = new Map<string, string>();
    for (const [file, d] of Object.entries(built))
      for (const p of d.panels)
        for (const t of p.targets ?? [])
          for (const m of t.expr.match(SERIES) ?? []) wanted.set(base(m), `${file}: ${p.title}`);
    expect(wanted.size).toBeGreaterThan(20);
    for (const [name, where] of wanted) expect(exported, `${name} (${where})`).toContain(name);
  });

  it("asks for them in the rules file too", () => {
    const rules = readFileSync(join(obs, "prometheus", "rules.yml"), "utf8");
    // Recorded series (`aidp:...`) are defined here, not exported; only the aidp_ names must exist.
    for (const m of rules.match(SERIES) ?? []) expect(exported, m).toContain(base(m));
  });

  it("states the SLO targets on the overview, with a threshold on each", () => {
    const overview = built["overview.json"]!;
    const titles = overview.panels.map((p) => p.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        expect.stringContaining("First token p95 (NFR-01, target < 2 s)"),
        expect.stringContaining("Voice first word p95 (target < 1.5 s)"),
        expect.stringContaining("Model call error rate"),
        expect.stringContaining("Oldest job waiting (queue age)"),
      ]),
    );
    const first = overview.panels.find((p) => p.title.startsWith("First token p95 ("));
    expect(JSON.stringify(first)).toContain('"value":2');
    const voice = overview.panels.find((p) => p.title.startsWith("Voice first word p95"));
    expect(JSON.stringify(voice)).toContain('"value":1.5');
  });

  it("gives every dashboard a unique uid, unique panel ids and the provisioned datasource", () => {
    const uids = new Set<string>();
    for (const [file, d] of Object.entries(built)) {
      expect(uids.has(d.uid), `${file} reuses ${d.uid}`).toBe(false);
      uids.add(d.uid);
      const ids = d.panels.map((p) => p.id);
      expect(new Set(ids).size, file).toBe(ids.length);
      for (const p of d.panels)
        if (p.type !== "row") expect(p.datasource?.uid, `${file}: ${p.title}`).toBe("prometheus");
    }
    const ds = readFileSync(join(obs, "grafana", "provisioning", "datasources", "datasources.yml"), "utf8");
    expect(ds).toContain("uid: prometheus");
  });

  it("scrapes the two ports the application serves metrics on", () => {
    const prom = readFileSync(join(obs, "prometheus", "prometheus.yml"), "utf8");
    const compose = readFileSync(join(root, "deploy", "compose.yml"), "utf8");
    expect(prom).toContain("api:9464");
    expect(prom).toContain("worker:9465");
    expect(compose).toMatch(/METRICS_PORT: "9464"/);
    expect(compose).toMatch(/METRICS_PORT: "9465"/);
    // Never published through the proxy.
    expect(readFileSync(join(root, "deploy", "Caddyfile"), "utf8")).not.toContain("9464");
  });

  it("fits a 4 GB host: the metrics profile adds under 450 MB of limits, and Grafana is loopback-only", () => {
    const compose = readFileSync(join(obs, "compose.yml"), "utf8");
    const limit = (service: string): number => {
      const block = compose.split(/\n {2}(?=[a-z]+:\n)/).find((b) => b.startsWith(`${service}:`)) ?? "";
      return Number(/memory: (\d+)M/.exec(block)?.[1] ?? Number.NaN);
    };
    expect(limit("prometheus") + limit("grafana")).toBeLessThan(450);
    expect(limit("tempo")).toBeLessThanOrEqual(192);
    expect(compose).toMatch(/profiles: \["observability"\]/);
    expect(compose).toMatch(/profiles: \["traces"\]/);
    expect(compose).toContain('"127.0.0.1:3001:3000"');
    // The admin password is required, not defaulted.
    expect(compose).toContain("GRAFANA_ADMIN_PASSWORD:?");
    expect(existsSync(join(obs, "README.md"))).toBe(true);
  });
});
