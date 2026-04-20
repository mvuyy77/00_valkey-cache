#!/usr/bin/env node
// =============================================================================
// benchmarks/k6/report.mjs — merge k6 + app-server metrics into one report.
//
// Reads:
//   benchmarks/k6/results/k6-results.json   (from handleSummary in load-test.js)
//   benchmarks/k6/results/app-metrics.json  (written by app-server on shutdown)
//
// Writes:
//   benchmarks/k6/results/report.md         (readable summary)
// Also prints the markdown to stdout.
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(here, "results");

const k6Path = resolve(resultsDir, "k6-results.json");
const appPath = resolve(resultsDir, "app-metrics.json");
const outPath = resolve(resultsDir, "report.md");

if (!existsSync(k6Path)) {
  console.error(`Missing ${k6Path} — did the k6 run finish?`);
  process.exit(1);
}
const k6 = JSON.parse(readFileSync(k6Path, "utf8"));
const app = existsSync(appPath) ? JSON.parse(readFileSync(appPath, "utf8")) : null;

if (!app) {
  console.warn(`Warning: ${appPath} not found — report will lack process-level metrics`);
}

const fmt = (n, d = 2) => (typeof n === "number" ? n.toFixed(d) : "n/a");
const pct = (n) => (typeof n === "number" ? (n * 100).toFixed(2) + "%" : "n/a");
const mb = (n) => (typeof n === "number" ? `${fmt(n, 1)} MB` : "n/a");
const ms = (n) => (typeof n === "number" ? `${fmt(n, 2)} ms` : "n/a");

const lines = [];
const push = (s = "") => lines.push(s);

push(`# k6 Benchmark Report`);
push();
push(`**Run:** ${k6.timestamp}`);
push();

push(`## Configuration`);
push();
push(`| Parameter | Value |`);
push(`|---|---|`);
push(`| Target | \`${k6.config.target}\` |`);
push(`| Scenario | ${k6.config.scenario} |`);
push(`| VUs | ${k6.config.vus} |`);
push(`| Duration (sustained phase) | ${k6.config.duration} |`);
push(`| Key pool | ${k6.config.keyPool} |`);
if (app?.config) {
  const c = app.config;
  push(`| Upstream | \`${c.base_url}\` |`);
  push(`| Declared payload size | ${c.payload_kb_declared != null ? c.payload_kb_declared + " KB" : "n/a (real upstream)"} |`);
  push(`| Container memory limit | ${c.container_memory_limit ?? "unset"} |`);
  push(`| Container CPU limit | ${c.container_cpu_limit ?? "unset"} |`);
  push(`| Node heap limit | ${c.node_heap_mb_limit ? c.node_heap_mb_limit + " MB" : "unset"} |`);
  push(`| Compression threshold | ${c.compression_threshold_bytes} B |`);
}
push();

push(`## Load`);
push();
push(`| Metric | Value |`);
push(`|---|---|`);
push(`| Total requests | ${k6.http.requests.toLocaleString()} |`);
push(`| Throughput | ${fmt(k6.http.rps, 1)} req/s |`);
push(`| Cache hits | ${k6.cache.hits.toLocaleString()} |`);
push(`| Cache misses | ${k6.cache.misses.toLocaleString()} |`);
push(`| Cache hit rate | ${pct(k6.cache.hitRate)} |`);
push(`| Error rate | ${pct(k6.errors.rate)} |`);
push();

if (app?.response_payload_bytes) {
  const p = app.response_payload_bytes;
  push(`## Observed Response Payload`);
  push();
  push(`| Metric | Value |`);
  push(`|---|---|`);
  push(`| Responses measured | ${p.count.toLocaleString()} |`);
  push(`| Avg size | ${(p.avg / 1024).toFixed(2)} KB (${p.avg.toLocaleString()} B) |`);
  push(`| Min size | ${(p.min / 1024).toFixed(2)} KB |`);
  push(`| Max size | ${(p.max / 1024).toFixed(2)} KB |`);
  push(`| Total bytes served | ${(p.total / 1024 / 1024).toFixed(1)} MB |`);
  push();
}

push(`## End-to-end Latency (HTTP from k6's perspective)`);
push();
if (k6.http.duration) {
  const d = k6.http.duration;
  push(`| Percentile | Latency |`);
  push(`|---|---|`);
  push(`| min | ${ms(d.min)} |`);
  push(`| p50 (median) | ${ms(d.med)} |`);
  push(`| avg | ${ms(d.avg)} |`);
  push(`| p90 | ${ms(d.p90)} |`);
  push(`| p95 | ${ms(d.p95)} |`);
  push(`| p99 | ${ms(d.p99)} |`);
  push(`| max | ${ms(d.max)} |`);
  push();
}

if (app?.event_loop_lag_ms) {
  const e = app.event_loop_lag_ms;
  push(`## Event Loop Lag (app-server process)`);
  push();
  push(`High values mean the Node.js event loop is blocked — callbacks queue up,`);
  push(`and user-facing latency tail grows. p99 > 50 ms is a red flag.`);
  push();
  push(`| Percentile | Lag |`);
  push(`|---|---|`);
  push(`| min | ${ms(e.min)} |`);
  push(`| mean | ${ms(e.mean)} |`);
  push(`| p50 | ${ms(e.p50)} |`);
  push(`| p90 | ${ms(e.p90)} |`);
  push(`| p95 | ${ms(e.p95)} |`);
  push(`| p99 | ${ms(e.p99)} |`);
  push(`| max | ${ms(e.max)} |`);
  push(`| stddev | ${ms(e.stddev)} |`);
  push();
}

if (app?.memory_mb) {
  const m = app.memory_mb;
  push(`## Memory (app-server process, final snapshot)`);
  push();
  push(`| Metric | Value |`);
  push(`|---|---|`);
  push(`| RSS (resident) | ${mb(m.rss)} |`);
  push(`| Heap used | ${mb(m.heap_used)} |`);
  push(`| Heap total | ${mb(m.heap_total)} |`);
  push(`| External (Buffers etc.) | ${mb(m.external)} |`);
  push(`| ArrayBuffers | ${mb(m.array_buffers)} |`);
  push();
}

if (app?.gc) {
  push(`## Garbage Collection (app-server process)`);
  push();
  push(`| Metric | Value |`);
  push(`|---|---|`);
  push(`| GC cycles | ${app.gc.count.toLocaleString()} |`);
  push(`| Total GC time | ${ms(app.gc.total_ms)} |`);
  push(`| Avg pause | ${ms(app.gc.avg_pause_ms)} |`);
  if (app.uptime_seconds > 0) {
    push(`| GC time as % of uptime | ${pct(app.gc.total_ms / 1000 / app.uptime_seconds)} |`);
  }
  push();
}

push(`## Thresholds`);
push();
const thresholds = k6.thresholds || {};
const thresholdEntries = Object.entries(thresholds);
if (thresholdEntries.length === 0) {
  push(`No thresholds reported.`);
} else {
  push(`| Threshold | Status |`);
  push(`|---|---|`);
  for (const [name, t] of thresholdEntries) {
    const status = t.ok === false ? "FAILED" : "passed";
    push(`| ${name} | ${status} |`);
  }
}
push();

push(`## Files`);
push();
push(`- \`results/k6-results.json\` — structured k6 summary`);
push(`- \`results/k6-raw.json\` — every k6 data point (for post-processing)`);
push(`- \`results/report.html\` — k6 interactive dashboard (time-series charts)`);
push(`- \`results/app-metrics.json\` — app-server process metrics`);
push(`- \`results/report.md\` — this file`);
push();

const md = lines.join("\n");
writeFileSync(outPath, md);
console.log(md);
console.log(`\nWrote ${outPath}`);
