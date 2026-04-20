// =============================================================================
// benchmarks/k6/app-server.ts — HTTP server wrapping ValkeyService.
//
// Mimics how consumers use the library in production: an HTTP server that calls
// ValkeyCacheWrapper.getWithFetch() for each request. k6 hits this server from
// outside the process, so latency measurements include real HTTP overhead.
//
// Routes:
//   GET /cache/:service?id=123    → getWithFetch(service, { baseUrl, queryParams })
//   GET /health                   → ValkeyService health check
//   GET /ready                    → readiness probe (always 200)
//
// Environment:
//   PORT           — listen port (default 3000)
//   BASE_URL       — upstream to fetch from on cache miss (mock-server or real)
//   VALKEY_HOST, VALKEY_PORT, VALKEY_PASSWORD, etc. — Valkey connection
// =============================================================================

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { ValkeyClient } from "../../src/core/client";
import { ValkeyService } from "../../src/core/service";
import { ServiceManifestConfig, Logger } from "../../src/types/types";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error("[fatal] BASE_URL is required (set UPSTREAM_URL for real profile, or use mock profile)");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Logger — structured but minimal for benchmarking
// ---------------------------------------------------------------------------
const LOG_LEVEL = process.env.LOG_LEVEL ?? "error";
const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const level = LEVELS[LOG_LEVEL] ?? 3;

const logger: Logger = {
  debug: level <= 0 ? (...args: any[]) => console.debug("[debug]", ...args) : () => {},
  info:  level <= 1 ? (...args: any[]) => console.log("[info]", ...args)    : () => {},
  warn:  level <= 2 ? (...args: any[]) => console.warn("[warn]", ...args)   : () => {},
  error: (...args: any[]) => console.error("[error]", ...args),
};

// ---------------------------------------------------------------------------
// Manifest — same routes the real consumers register
// ---------------------------------------------------------------------------
const MANIFEST: Record<string, ServiceManifestConfig> = {
  getUserProfileByLoginId: {
    serviceName: "nmlvhub-ms-userprofile",
    method: "GET",
    relativePath: "/profile/loginid",
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
  },
  getUserProfileByNMU: {
    serviceName: "nmlvhub-ms-userprofile",
    method: "GET",
    relativePath: "/profile/",
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
  },
  getFieldDetailsByFieldNMU: {
    serviceName: "nmlvhub-ms-field",
    method: "GET",
    relativePath: "/field/",
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
  },
  getCXAuthProfile: {
    serviceName: "ms-authprofile-v2",
    method: "GET",
    relativePath: "/v1/auth-profile",
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
  },
  mockService: {
    serviceName: "mock-service",
    method: "GET",
    relativePath: "/mock-service",
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
  },
};

const SERVICE_NAMES = Object.keys(MANIFEST);

// ---------------------------------------------------------------------------
// Observability — event loop lag, GC, memory, response payload sizes
// ---------------------------------------------------------------------------
const METRICS_PATH = process.env.METRICS_PATH ?? "/results/app-metrics.json";

const eventLoopLag = monitorEventLoopDelay({ resolution: 10 });
eventLoopLag.enable();

let gcCount = 0;
let gcTotalMs = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount++;
    gcTotalMs += entry.duration;
  }
}).observe({ entryTypes: ["gc"] });

let payloadCount = 0;
let payloadSumBytes = 0;
let payloadMinBytes = Number.POSITIVE_INFINITY;
let payloadMaxBytes = 0;

function trackPayload(bytes: number): void {
  payloadCount++;
  payloadSumBytes += bytes;
  if (bytes < payloadMinBytes) payloadMinBytes = bytes;
  if (bytes > payloadMaxBytes) payloadMaxBytes = bytes;
}

function resetMetrics(): void {
  eventLoopLag.reset();
  gcCount = 0;
  gcTotalMs = 0;
  payloadCount = 0;
  payloadSumBytes = 0;
  payloadMinBytes = Number.POSITIVE_INFINITY;
  payloadMaxBytes = 0;
}

function snapshotMetrics() {
  const mem = process.memoryUsage();
  const heapLimitMatch = (process.env.NODE_OPTIONS ?? "").match(/--max-old-space-size=(\d+)/);
  return {
    timestamp: new Date().toISOString(),
    uptime_seconds: Number(process.uptime().toFixed(2)),
    config: {
      port: PORT,
      base_url: BASE_URL,
      payload_kb_declared: process.env.PAYLOAD_KB ? parseInt(process.env.PAYLOAD_KB, 10) : null,
      node_heap_mb_limit: heapLimitMatch ? parseInt(heapLimitMatch[1], 10) : null,
      container_memory_limit: process.env.CONTAINER_MEMORY_LIMIT ?? null,
      container_cpu_limit: process.env.CONTAINER_CPU_LIMIT ?? null,
      compression_threshold_bytes: 1024,
    },
    requests_observed: payloadCount,
    response_payload_bytes: {
      count: payloadCount,
      avg: payloadCount ? Math.round(payloadSumBytes / payloadCount) : 0,
      min: payloadMinBytes === Number.POSITIVE_INFINITY ? 0 : payloadMinBytes,
      max: payloadMaxBytes,
      total: payloadSumBytes,
    },
    event_loop_lag_ms: {
      min: +(eventLoopLag.min / 1e6).toFixed(3),
      mean: +(eventLoopLag.mean / 1e6).toFixed(3),
      stddev: +(eventLoopLag.stddev / 1e6).toFixed(3),
      p50: +(eventLoopLag.percentile(50) / 1e6).toFixed(3),
      p90: +(eventLoopLag.percentile(90) / 1e6).toFixed(3),
      p95: +(eventLoopLag.percentile(95) / 1e6).toFixed(3),
      p99: +(eventLoopLag.percentile(99) / 1e6).toFixed(3),
      max: +(eventLoopLag.max / 1e6).toFixed(3),
    },
    memory_mb: {
      rss: +(mem.rss / 1024 / 1024).toFixed(1),
      heap_used: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heap_total: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      external: +(mem.external / 1024 / 1024).toFixed(1),
      array_buffers: +(mem.arrayBuffers / 1024 / 1024).toFixed(1),
    },
    gc: {
      count: gcCount,
      total_ms: +gcTotalMs.toFixed(1),
      avg_pause_ms: gcCount ? +(gcTotalMs / gcCount).toFixed(3) : 0,
    },
  };
}

function dumpMetricsToDisk(): void {
  try {
    writeFileSync(METRICS_PATH, JSON.stringify(snapshotMetrics(), null, 2));
  } catch (err: any) {
    logger.warn("failed to write metrics file:", err.message);
  }
}

// Dump every second so the file is fresh when k6 exits
setInterval(dumpMetricsToDisk, 1000).unref();

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
let service: ValkeyService;

async function init() {
  const client = new ValkeyClient(logger);
  service = new ValkeyService(client as any, MANIFEST, logger);
  await client.connect();
  logger.info("ValkeyService initialised, upstream:", BASE_URL);
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------
function parseUrl(url: string): { path: string; query: Record<string, string> } {
  const qIdx = url.indexOf("?");
  const path = qIdx === -1 ? url : url.slice(0, qIdx);
  const query: Record<string, string> = {};
  if (qIdx !== -1) {
    for (const pair of url.slice(qIdx + 1).split("&")) {
      const [k, v] = pair.split("=");
      if (k) query[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
    }
  }
  return { path, query };
}

async function handler(req: IncomingMessage, res: ServerResponse) {
  const { path, query } = parseUrl(req.url ?? "/");

  // GET /ready — lightweight readiness probe
  if (path === "/ready") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // GET /metrics — process-level observability
  if (path === "/metrics") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(snapshotMetrics()));
    return;
  }

  // POST /metrics/reset — zero the histograms (call from k6 setup)
  if (path === "/metrics/reset") {
    resetMetrics();
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /metrics/dump — force-write the metrics file (call from k6 teardown)
  if (path === "/metrics/dump") {
    dumpMetricsToDisk();
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /health — full Valkey health check
  if (path === "/health") {
    try {
      const h = await service.health();
      const code = h.status === "UP" ? 200 : 503;
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(h));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /cache/:serviceName?id=...&otherParam=...
  const cacheMatch = path.match(/^\/cache\/([^/]+)$/);
  if (cacheMatch) {
    const serviceName = cacheMatch[1];
    if (!MANIFEST[serviceName]) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown service: ${serviceName}` }));
      return;
    }

    try {
      const result = await service.getOrFetch(serviceName, {
        baseUrl: BASE_URL,
        queryParams: Object.keys(query).length > 0 ? query : undefined,
      });

      const isHit = result.upstreamStatus === undefined;
      const body = result.data ? JSON.stringify(result.data) : "";
      if (body) trackPayload(Buffer.byteLength(body));
      res.writeHead(body ? 200 : 204, {
        "Content-Type": "application/json",
        "X-Cache": isHit ? "HIT" : "MISS",
      });
      res.end(body);
    } catch (err: any) {
      const status = err.status ?? 500;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /cache/random?id=... — pick a random service (simulates mixed traffic)
  // Handled above if "random" isn't a real service name, so add explicit route:
  if (path === "/cache/random") {
    const serviceName = SERVICE_NAMES[Math.floor(Math.random() * SERVICE_NAMES.length)];
    // Rewrite and recurse through handler
    req.url = `/cache/${serviceName}${req.url!.includes("?") ? req.url!.slice(req.url!.indexOf("?")) : ""}`;
    return handler(req, res);
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const server = createServer(handler);

function shutdown() {
  console.log("[app-server] Shutting down — writing final metrics");
  dumpMetricsToDisk();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[app-server] Listening on :${PORT}`);
      console.log(`[app-server] Upstream: ${BASE_URL}`);
      console.log(`[app-server] Services: ${SERVICE_NAMES.join(", ")}`);
    });
  })
  .catch((err) => {
    console.error("[app-server] Failed to initialise:", err);
    process.exit(1);
  });
