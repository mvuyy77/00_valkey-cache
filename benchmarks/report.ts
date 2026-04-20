// =============================================================================
// benchmarks/report.ts — Generates HTML report from benchmark results.
//
// Usage: npx tsx benchmarks/report.ts
// Input:  benchmarks/results.json
// Output: benchmarks/report.html
// =============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const resultsPath = resolve(__dirname, "results.json");
const outputPath = resolve(__dirname, "report.html");

const raw = readFileSync(resultsPath, "utf-8");
const results = JSON.parse(raw);

const { config, summary, endpointStats } = results;

// -------------------------------------------------------------------------
// Build per-endpoint rows — data is already aggregated in results.json
// -------------------------------------------------------------------------
const endpointRows = Object.entries(endpointStats as Record<string, any>).map(([name, s]) => ({
  name,
  total: s.latencyCount,
  hits: s.hits,
  hitPct: s.latencyCount > 0 ? Math.round((s.hits / s.latencyCount) * 100) : 0,
  misses: s.misses,
  bypasses: s.bypasses,
  errors: s.errors,
  circuitOpens: s.circuitOpens,
  avgLat: s.avgLatencyMs,
  p50: s.p50LatencyMs,
  p95: s.p95LatencyMs,
  p99: s.p99LatencyMs,
}));

// -------------------------------------------------------------------------
// Build HTML
// -------------------------------------------------------------------------
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>valkey-cache benchmark report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafaf8; color: #1a1a1a; padding: 40px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 500; margin-bottom: 6px; }
  h2 { font-size: 15px; font-weight: 600; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e5e5e0; text-transform: uppercase; letter-spacing: 0.04em; color: #555; }
  .subtitle { font-size: 13px; color: #888; margin-bottom: 24px; }
  .config { font-size: 13px; color: #666; background: #f0f0eb; border-radius: 6px; padding: 10px 14px; margin-bottom: 28px; }
  .config span { font-weight: 600; color: #1a1a1a; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid #e5e5e0; border-radius: 8px; overflow: hidden; }
  th { background: #f5f5f2; text-align: left; padding: 10px 14px; font-weight: 600; color: #555; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; border-bottom: 1px solid #e5e5e0; }
  td { padding: 9px 14px; border-bottom: 1px solid #f0f0eb; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #fafaf5; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .summary-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; border: 1px solid #e5e5e0; border-radius: 8px; overflow: hidden; background: #fff; }
  .summary-cell { padding: 16px 20px; border-right: 1px solid #e5e5e0; border-bottom: 1px solid #e5e5e0; }
  .summary-cell:nth-child(3n) { border-right: none; }
  .summary-cell:nth-last-child(-n+3) { border-bottom: none; }
  .summary-cell .label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
  .summary-cell .value { font-size: 22px; font-weight: 500; }
  .summary-cell .unit { font-size: 11px; color: #aaa; margin-top: 2px; }
</style>
</head>
<body>

<h1>valkey-cache benchmark report</h1>
<p class="subtitle">Generated ${new Date().toISOString()}</p>

<div class="config">
  Mode: <span>${config.mode}</span> &nbsp;&nbsp;
  Concurrency: <span>${config.concurrency}</span> &nbsp;&nbsp;
  Duration: <span>${config.durationSec}s</span> &nbsp;&nbsp;
  Payload: <span>${config.payloadKB}KB</span> &nbsp;&nbsp;
  Key pool: <span>${config.keyPoolSize} unique IDs</span>
  <br style="margin-bottom:6px">
  Cache: <span>${config.cacheBackend}</span> &nbsp;&nbsp;
  Upstream: <span>${config.upstreamBackend}</span> &nbsp;&nbsp;
  Base URL: <span>${config.baseUrl}</span>
  <br style="margin-bottom:6px">
  Container memory: <span>${config.containerMemoryLimit}</span> &nbsp;&nbsp;
  Container CPU: <span>${config.containerCpuLimit} vCPU</span> &nbsp;&nbsp;
  V8 heap cap: <span>${config.v8HeapLimitMB}MB</span>
</div>

<h2>Summary</h2>
<div class="summary-grid">
  <div class="summary-cell"><div class="label">Total requests</div><div class="value">${summary.totalRequests.toLocaleString()}</div></div>
  <div class="summary-cell"><div class="label">Throughput</div><div class="value">${summary.requestsPerSec.toLocaleString()}</div><div class="unit">req / sec</div></div>
  <div class="summary-cell"><div class="label">Cache hit rate</div><div class="value">${summary.totalRequests > 0 ? Math.round((summary.hits / summary.totalRequests) * 100) : 0}%</div><div class="unit">${summary.hits.toLocaleString()} hits</div></div>
  <div class="summary-cell"><div class="label">Cache misses</div><div class="value">${summary.misses.toLocaleString()}</div></div>
  <div class="summary-cell"><div class="label">Errors</div><div class="value">${summary.errors.toLocaleString()}</div></div>
  <div class="summary-cell"><div class="label">Circuit opens</div><div class="value">${summary.circuitOpens.toLocaleString()}</div></div>
  <div class="summary-cell"><div class="label">Avg latency</div><div class="value">${summary.avgLatencyMs}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">p50 latency</div><div class="value">${summary.p50LatencyMs}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">p95 latency</div><div class="value">${summary.p95LatencyMs}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">p99 latency</div><div class="value">${summary.p99LatencyMs}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">Peak heap</div><div class="value">${summary.peakHeapMB}</div><div class="unit">MB</div></div>
  <div class="summary-cell"><div class="label">Peak RSS</div><div class="value">${summary.peakRssMB}</div><div class="unit">MB</div></div>
  <div class="summary-cell"><div class="label">Avg CPU</div><div class="value">${summary.avgCpuPercent}</div><div class="unit">%</div></div>
  <div class="summary-cell"><div class="label">EL lag p50</div><div class="value">${summary.elLagP50Ms}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">EL lag p95</div><div class="value">${summary.elLagP95Ms}</div><div class="unit">ms</div></div>
  <div class="summary-cell"><div class="label">EL lag max</div><div class="value">${summary.elLagMaxMs}</div><div class="unit">ms</div></div>
</div>

<h2>Per-endpoint breakdown</h2>
<table>
  <thead>
    <tr>
      <th>Endpoint</th>
      <th class="num">Requests</th>
      <th class="num">Hits</th>
      <th class="num">Hit %</th>
      <th class="num">Misses</th>
      <th class="num">Bypasses</th>
      <th class="num">Errors</th>
      <th class="num">Circuit opens</th>
      <th class="num">Avg (ms)</th>
      <th class="num">p50 (ms)</th>
      <th class="num">p95 (ms)</th>
      <th class="num">p99 (ms)</th>
    </tr>
  </thead>
  <tbody>
    ${endpointRows.map(r => `
    <tr>
      <td>${r.name}</td>
      <td class="num">${r.total.toLocaleString()}</td>
      <td class="num">${r.hits.toLocaleString()}</td>
      <td class="num">${r.hitPct}%</td>
      <td class="num">${r.misses.toLocaleString()}</td>
      <td class="num">${r.bypasses.toLocaleString()}</td>
      <td class="num">${r.errors.toLocaleString()}</td>
      <td class="num">${r.circuitOpens.toLocaleString()}</td>
      <td class="num">${r.avgLat}</td>
      <td class="num">${r.p50}</td>
      <td class="num">${r.p95}</td>
      <td class="num">${r.p99}</td>
    </tr>`).join("")}
  </tbody>
</table>

</body>
</html>`;

writeFileSync(outputPath, html);
console.log(`[report] HTML report written to: ${outputPath}`);
console.log(`[report] Open in browser: open ${outputPath}`);
