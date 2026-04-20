// =============================================================================
// benchmarks/k6/load-test.js — k6 load test script.
//
// Generates load against the app-server, which wraps ValkeyService.
// Measures true end-to-end latency from outside the Node.js process,
// exactly as real consumers experience it.
//
// Scenarios:
//   warmup     → ramp up to target VUs, prime the cache
//   sustained  → hold steady load for the configured duration
//   spike      → brief burst at 2x VUs to test behaviour under pressure
//
// Usage:
//   k6 run load-test.js
//   k6 run --env TARGET=http://app-server:3000 --env VUS=200 load-test.js
//   k6 run --env SCENARIO=sustained load-test.js
// =============================================================================

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { textSummary as k6TextSummary } from "https://jslib.k6.io/k6-summary/0.0.2/index.js";

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const TARGET = __ENV.TARGET || "http://app-server:3000";
const VUS = parseInt(__ENV.VUS || "200", 10);
const DURATION = __ENV.DURATION || "30s";
const KEY_POOL = parseInt(__ENV.KEY_POOL || "500", 10);
const SCENARIO = __ENV.SCENARIO || "all"; // "warmup", "sustained", "spike", "all"

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------
const cacheHits = new Counter("cache_hits");
const cacheMisses = new Counter("cache_misses");
const cacheHitRate = new Rate("cache_hit_rate");
const errorRate = new Rate("error_rate");
const latencyByService = new Trend("latency_by_service", true);

// ---------------------------------------------------------------------------
// Services to test — matches the manifest in app-server
// ---------------------------------------------------------------------------
const SERVICES = [
  "getUserProfileByLoginId",
  "getUserProfileByNMU",
  "getFieldDetailsByFieldNMU",
  "getCXAuthProfile",
  "mockService",
];

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
function buildScenarios() {
  const scenarios = {};

  if (SCENARIO === "warmup" || SCENARIO === "all") {
    scenarios.warmup = {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: VUS },     // ramp up
        { duration: "20s", target: VUS },     // hold to prime cache
      ],
      gracefulRampDown: "5s",
    };
  }

  if (SCENARIO === "sustained" || SCENARIO === "all") {
    scenarios.sustained = {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
      startTime: SCENARIO === "all" ? "35s" : "0s", // after warmup
    };
  }

  if (SCENARIO === "spike" || SCENARIO === "all") {
    scenarios.spike = {
      executor: "ramping-vus",
      startVUs: VUS,
      stages: [
        { duration: "5s", target: VUS * 2 },   // spike to 2x
        { duration: "10s", target: VUS * 2 },  // hold spike
        { duration: "5s", target: VUS },        // ramp back down
      ],
      // After warmup + sustained
      startTime: SCENARIO === "all" ? `${35 + parseDuration(DURATION)}s` : "0s",
      gracefulRampDown: "5s",
    };
  }

  return scenarios;
}

function parseDuration(d) {
  const match = d.match(/^(\d+)(s|m|h)$/);
  if (!match) return 30;
  const val = parseInt(match[1], 10);
  if (match[2] === "m") return val * 60;
  if (match[2] === "h") return val * 3600;
  return val;
}

export const options = {
  scenarios: buildScenarios(),
  thresholds: {
    http_req_duration: ["p(95)<200", "p(99)<500"],   // SLA targets
    error_rate: ["rate<0.01"],                         // <1% errors
    cache_hit_rate: ["rate>0.80"],                     // >80% cache hits after warmup
  },
  // Summary output as JSON for programmatic consumption
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

// ---------------------------------------------------------------------------
// Setup / teardown — reset app-server metrics at start, flush at end
// ---------------------------------------------------------------------------
export function setup() {
  const r = http.post(`${TARGET}/metrics/reset`);
  if (r.status !== 204) console.warn(`metrics reset returned ${r.status}`);
  return {};
}

export function teardown() {
  const r = http.post(`${TARGET}/metrics/dump`);
  if (r.status !== 204) console.warn(`metrics dump returned ${r.status}`);
}

// ---------------------------------------------------------------------------
// Default function — called once per VU iteration
// ---------------------------------------------------------------------------
export default function () {
  // Pick a random service and ID
  const service = SERVICES[Math.floor(Math.random() * SERVICES.length)];
  const id = Math.floor(Math.random() * KEY_POOL) + 1;

  const url = `${TARGET}/cache/${service}?id=${id}`;
  const res = http.get(url, {
    tags: { service: service },
    timeout: "10s",
  });

  // Track cache hit/miss from X-Cache header
  const isHit = res.headers["X-Cache"] === "HIT" || res.headers["x-cache"] === "HIT";
  if (isHit) {
    cacheHits.add(1);
    cacheHitRate.add(1);
  } else {
    cacheMisses.add(1);
    cacheHitRate.add(0);
  }

  // Track errors
  const isError = res.status >= 400;
  errorRate.add(isError ? 1 : 0);

  // Per-service latency
  latencyByService.add(res.timings.duration, { service: service });

  // Assertions
  check(res, {
    "status is 200 or 204": (r) => r.status === 200 || r.status === 204,
    "response has body": (r) => r.status === 204 || (r.body && r.body.length > 0),
    "has cache header": (r) => r.headers["X-Cache"] !== undefined || r.headers["x-cache"] !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Custom summary — produce a structured JSON report
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    config: {
      target: TARGET,
      vus: VUS,
      duration: DURATION,
      keyPool: KEY_POOL,
      scenario: SCENARIO,
    },
    http: {
      requests: data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0,
      rps: data.metrics.http_reqs ? data.metrics.http_reqs.values.rate : 0,
      duration: data.metrics.http_req_duration
        ? {
            avg: data.metrics.http_req_duration.values.avg,
            min: data.metrics.http_req_duration.values.min,
            med: data.metrics.http_req_duration.values.med,
            p90: data.metrics.http_req_duration.values["p(90)"],
            p95: data.metrics.http_req_duration.values["p(95)"],
            p99: data.metrics.http_req_duration.values["p(99)"],
            max: data.metrics.http_req_duration.values.max,
          }
        : null,
    },
    cache: {
      hits: data.metrics.cache_hits ? data.metrics.cache_hits.values.count : 0,
      misses: data.metrics.cache_misses ? data.metrics.cache_misses.values.count : 0,
      hitRate: data.metrics.cache_hit_rate ? data.metrics.cache_hit_rate.values.rate : 0,
    },
    errors: {
      rate: data.metrics.error_rate ? data.metrics.error_rate.values.rate : 0,
    },
    thresholds: data.thresholds || {},
  };

  return {
    "/results/k6-results.json": JSON.stringify(summary, null, 2),
    stdout:
      k6TextSummary(data, { indent: " ", enableColors: true }) +
      "\n" +
      textSummary(summary),
  };
}

function textSummary(s) {
  const lines = [
    "",
    "=== k6 Benchmark Results ===",
    "",
    `  Requests:     ${s.http.requests.toLocaleString()} total (${s.http.rps.toFixed(1)} req/s)`,
    `  Cache:        ${s.cache.hits.toLocaleString()} hits / ${s.cache.misses.toLocaleString()} misses (${(s.cache.hitRate * 100).toFixed(1)}% hit rate)`,
    `  Error rate:   ${(s.errors.rate * 100).toFixed(2)}%`,
    "",
  ];

  if (s.http.duration) {
    lines.push("  Latency:");
    lines.push(`    avg:  ${s.http.duration.avg.toFixed(2)}ms`);
    lines.push(`    med:  ${s.http.duration.med.toFixed(2)}ms`);
    lines.push(`    p90:  ${s.http.duration.p90.toFixed(2)}ms`);
    lines.push(`    p95:  ${s.http.duration.p95.toFixed(2)}ms`);
    lines.push(`    p99:  ${s.http.duration.p99.toFixed(2)}ms`);
    lines.push(`    max:  ${s.http.duration.max.toFixed(2)}ms`);
    lines.push("");
  }

  // Check thresholds
  const failed = Object.entries(s.thresholds).filter(([_, v]) => v.ok === false);
  if (failed.length > 0) {
    lines.push("  FAILED thresholds:");
    for (const [name] of failed) {
      lines.push(`    - ${name}`);
    }
    lines.push("");
  } else {
    lines.push("  All thresholds passed.");
    lines.push("");
  }

  return lines.join("\n");
}
