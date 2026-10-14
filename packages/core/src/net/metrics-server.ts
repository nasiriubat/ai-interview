import { createServer, type Server } from "node:http";
import type { Metrics } from "../telemetry/metrics.js";

/**
 * The scrape endpoint (D-222): `GET /metrics` on a port that is on the compose network and in no
 * Caddy route, so the numbers are readable by Prometheus and by nobody on the internet.
 *
 * Plain `node:http` and one route: it must keep answering while the application it measures is
 * struggling, so it shares nothing with Fastify (no hooks, no rate limiter, no auth) and refuses
 * everything but a GET of that one path.
 */
export function startMetricsServer(
  metrics: Pick<Metrics, "render">,
  options: { port: number; host?: string; onError?: (err: unknown) => void },
): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET" || path !== "/metrics") {
      res.writeHead(path === "/metrics" ? 405 : 404, { "content-type": "text/plain" });
      res.end("not found\n");
      return;
    }
    try {
      const body = metrics.render();
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(body);
    } catch (err) {
      options.onError?.(err);
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("error\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      // A bound port that fails later must not take the process down; it is only a metrics port.
      server.on("error", (err) => options.onError?.(err));
      resolve(server);
    });
  });
}
