// =============================================================================
// benchmarks/run.ts — Drives load against ValkeyService, collects metrics.
//
// Two modes:
//   MODE=mock  → In-memory Map replaces Valkey. No Docker needed. Tests library
//                CPU/memory in isolation. Mock upstream server must be running.
//   MODE=real  → Real Valkey via Docker. Full end-to-end. Docker Compose must be up.
//
// CPU profiling:
//   Set PROFILE=1 to capture a V8 CPU profile during the benchmark window.
//   Writes benchmarks/cpu.cpuprofile (viewable in Chrome DevTools → Performance)
//   and benchmarks/cpu-summary.txt (top functions by self-time).
//
// Usage:
//   npx tsx benchmarks/run.ts
//   MODE=real CONCURRENCY=100 DURATION_SEC=30 npx tsx benchmarks/run.ts
//   PROFILE=1 npx tsx benchmarks/run.ts
//
// Output: benchmarks/results.json
// =============================================================================

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Session } from "node:inspector/promises";
import { ValkeyService } from "../src/core/service";
import { CircuitOpenError, Logger, ServiceManifestConfig } from "../src/types/types";

const PROFILE = process.env.PROFILE === "1";

// -------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------
const MODE = process.env.MODE ?? "mock";
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "100", 10);
const DURATION_SEC = parseInt(process.env.DURATION_SEC ?? "30", 10);
const SAMPLE_INTERVAL_MS = parseInt(process.env.SAMPLE_INTERVAL_MS ?? "200", 10);
const BASE_URL = process.env.BASE_URL ?? "http://localhost:4000";
const PAYLOAD_KB = parseInt(process.env.PAYLOAD_KB ?? "500", 10);
const KEY_POOL_SIZE = parseInt(process.env.KEY_POOL_SIZE ?? "500", 10);
const CONTAINER_MEMORY_LIMIT = process.env.CONTAINER_MEMORY_LIMIT ?? "unset";
const CONTAINER_CPU_LIMIT = process.env.CONTAINER_CPU_LIMIT ?? "unset";
const V8_HEAP_LIMIT_MB = process.env.V8_HEAP_LIMIT_MB ?? "unset";

// Pre-generated ID pool — each entry becomes a distinct cache key via queryParams.
// Uniform random draw per request, so the cache sees KEY_POOL_SIZE unique keys
// rather than the 5 static keys from the manifest.
const ID_POOL = Array.from({ length: KEY_POOL_SIZE }, (_, i) => String(i + 1));

// Max latency samples kept per endpoint for percentile calculation (reservoir sampling).
// Keeps memory bounded regardless of total request count.
const MAX_LATENCY_SAMPLE = 10_000;

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------
interface MemorySample {
  timestampMs: number;
  heapUsedMB: number;
  heapTotalMB: number;
  rssMB: number;
  externalMB: number;
  arrayBuffersMB: number;
  cpuUserMs: number;
  cpuSystemMs: number;
}

interface EndpointStats {
  hits: number;
  misses: number;
  bypasses: number;
  errors: number;
  circuitOpens: number;
  latencySum: number;
  latencyCount: number;
  latencySample: number[];  // reservoir, max MAX_LATENCY_SAMPLE entries
}

interface BenchmarkResults {
  config: {
    mode: string;
    concurrency: number;
    durationSec: number;
    payloadKB: number;
    keyPoolSize: number;
    baseUrl: string;
    cacheBackend: string;
    upstreamBackend: string;
    containerMemoryLimit: string;
    containerCpuLimit: string;
    v8HeapLimitMB: string;
  };
  summary: {
    totalRequests: number;
    hits: number;
    misses: number;
    errors: number;
    circuitOpens: number;
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
    requestsPerSec: number;
    peakHeapMB: number;
    peakRssMB: number;
    avgCpuPercent: number;
    elLagP50Ms: number;
    elLagP95Ms: number;
    elLagP99Ms: number;
    elLagMaxMs: number;
  };
  memorySamples: MemorySample[];
  endpointStats: Record<string, Omit<EndpointStats, "latencySample"> & {
    avgLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    p99LatencyMs: number;
  }>;
}

// -------------------------------------------------------------------------
// Benchmark manifest — mirrors the real SERVICES_MANIFEST routes.
// All routes resolve to the mock server during benchmarking.
// -------------------------------------------------------------------------
const BENCH_MANIFEST: Record<string, ServiceManifestConfig> = {
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

// -------------------------------------------------------------------------
// Endpoints to cycle through
// -------------------------------------------------------------------------
const ENDPOINTS = [
  { prefix: "getUserProfileByLoginId", params: undefined },
  { prefix: "getUserProfileByNMU", params: undefined },
  { prefix: "getFieldDetailsByFieldNMU", params: undefined },
  { prefix: "getCXAuthProfile", params: undefined },
  { prefix: "mockService", params: undefined },
];

// -------------------------------------------------------------------------
// Mock Valkey glide client (in-memory Map)
// -------------------------------------------------------------------------
class MockGlideClient {
  private store = new Map<string, { value: Buffer; expiresAt: number }>();

  async get(key: string, _options?: unknown): Promise<Buffer | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: Buffer, options?: any): Promise<string | null> {
    const isNX = options?.conditionalSet === "onlyIfDoesNotExist";
    if (isNX) {
      const entry = this.store.get(key);
      if (entry && Date.now() <= entry.expiresAt) return null;
    }
    const ttlMs = options?.expiry?.count ? options.expiry.count * 1000 : 60_000;
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  async exists(keys: string[]): Promise<number> {
    return keys.filter((k) => {
      const entry = this.store.get(k);
      return entry !== undefined && Date.now() <= entry.expiresAt;
    }).length;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  getStatistics(): null {
    return null;
  }

  close(): void {
    this.store.clear();
  }
}

// -------------------------------------------------------------------------
// Mock ValkeyClient — matches the interface ValkeyService calls on its client
// -------------------------------------------------------------------------
class MockValkeyClient {
  private glideClient = new MockGlideClient();

  connect(): Promise<MockGlideClient> {
    return Promise.resolve(this.glideClient);
  }

  async disconnect(): Promise<void> {
    this.glideClient.close();
  }
}

// -------------------------------------------------------------------------
// Logger — silence all output during the run to avoid I/O skewing CPU metrics
// -------------------------------------------------------------------------
const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// -------------------------------------------------------------------------
// Metrics — aggregated in-flight, no unbounded arrays
// -------------------------------------------------------------------------
const memorySamples: MemorySample[] = [];
const epStats = new Map<string, EndpointStats>();
let cpuPrev = process.cpuUsage();

function getOrCreateEpStats(endpoint: string): EndpointStats {
  let s = epStats.get(endpoint);
  if (!s) {
    s = { hits: 0, misses: 0, bypasses: 0, errors: 0, circuitOpens: 0, latencySum: 0, latencyCount: 0, latencySample: [] };
    epStats.set(endpoint, s);
  }
  return s;
}

// Reservoir sampling (Algorithm R) — keeps a representative fixed-size sample.
function reservoirAdd(sample: number[], value: number, totalSeen: number): void {
  if (sample.length < MAX_LATENCY_SAMPLE) {
    sample.push(value);
  } else {
    const idx = Math.floor(Math.random() * totalSeen);
    if (idx < MAX_LATENCY_SAMPLE) {
      sample[idx] = value;
    }
  }
}

function recordRequest(endpoint: string, status: "hit" | "miss" | "bypass" | "error" | "circuit_open", elapsedMs: number): void {
  const s = getOrCreateEpStats(endpoint);
  s.latencySum += elapsedMs;
  s.latencyCount++;
  reservoirAdd(s.latencySample, elapsedMs, s.latencyCount);
  if (status === "hit") s.hits++;
  else if (status === "miss") s.misses++;
  else if (status === "bypass") s.bypasses++;
  else if (status === "error") s.errors++;
  else if (status === "circuit_open") s.circuitOpens++;
}

function sampleMemory(): void {
  const mem = process.memoryUsage();
  const cpuNow = process.cpuUsage(cpuPrev);
  memorySamples.push({
    timestampMs: Date.now(),
    heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    externalMB: Math.round((mem.external / 1024 / 1024) * 100) / 100,
    arrayBuffersMB: Math.round((mem.arrayBuffers / 1024 / 1024) * 100) / 100,
    cpuUserMs: Math.round(cpuNow.user / 1000),
    cpuSystemMs: Math.round(cpuNow.system / 1000),
  });
  cpuPrev = process.cpuUsage();
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * (p / 100)) - 1;
  return Math.round(sorted[Math.max(0, idx)] * 100) / 100;
}

// -------------------------------------------------------------------------
// CPU profile summariser
// -------------------------------------------------------------------------
// V8 CPU profile format: nodes[] where each node has a callFrame
// (functionName, url, lineNumber) and hitCount. hitCount = number of ticks
// where that function was at the top of the stack (self time).
// We aggregate by function+location and sort by self-ticks descending.
function summarizeProfile(profile: any): string {
  const nodes: any[] = profile.nodes ?? [];
  const totalTicks = nodes.reduce((sum: number, n: any) => sum + (n.hitCount ?? 0), 0);
  if (totalTicks === 0) return "(no ticks recorded)\n";

  // Aggregate self-ticks by function + source location
  const byFunc = new Map<string, { ticks: number; fn: string; location: string }>();
  for (const node of nodes) {
    const cf = node.callFrame;
    if (!cf || (node.hitCount ?? 0) === 0) continue;

    const fn = cf.functionName || "(anonymous)";
    // Clean up the URL to just show the relevant path
    let loc = cf.url ?? "";
    const appIdx = loc.indexOf("/src/");
    const benchIdx = loc.indexOf("/benchmarks/");
    if (appIdx !== -1) loc = loc.slice(appIdx);
    else if (benchIdx !== -1) loc = loc.slice(benchIdx);
    else if (loc.includes("node_modules/")) {
      const nmIdx = loc.indexOf("node_modules/");
      loc = loc.slice(nmIdx);
    }
    if (cf.lineNumber >= 0) loc += `:${cf.lineNumber + 1}`;

    const key = `${fn}@${loc}`;
    const existing = byFunc.get(key);
    if (existing) {
      existing.ticks += node.hitCount;
    } else {
      byFunc.set(key, { ticks: node.hitCount, fn, location: loc });
    }
  }

  // Sort by ticks descending, take top 40
  const sorted = [...byFunc.values()].sort((a, b) => b.ticks - a.ticks).slice(0, 40);

  const lines: string[] = [];
  lines.push(`V8 CPU Profile Summary — ${totalTicks} total ticks\n`);
  lines.push(`${"Self %".padStart(8)}  ${"Ticks".padStart(7)}  ${"Function".padEnd(40)}  Location`);
  lines.push(`${"------".padStart(8)}  ${"-----".padStart(7)}  ${"--------".padEnd(40)}  --------`);

  for (const entry of sorted) {
    const pct = ((entry.ticks / totalTicks) * 100).toFixed(1).padStart(7);
    const ticks = String(entry.ticks).padStart(7);
    const fn = entry.fn.length > 40 ? entry.fn.slice(0, 37) + "..." : entry.fn.padEnd(40);
    lines.push(`${pct}%  ${ticks}  ${fn}  ${entry.location}`);
  }

  // Add category breakdown
  let appTicks = 0, benchTicks = 0, nodeTicks = 0, depTicks = 0, otherTicks = 0;
  for (const entry of byFunc.values()) {
    const loc = entry.location;
    if (loc.startsWith("/src/")) appTicks += entry.ticks;
    else if (loc.startsWith("/benchmarks/")) benchTicks += entry.ticks;
    else if (loc.includes("node_modules/")) depTicks += entry.ticks;
    else if (loc.includes("node:") || loc === "") nodeTicks += entry.ticks;
    else otherTicks += entry.ticks;
  }

  lines.push("");
  lines.push("Category Breakdown:");
  lines.push(`  Your library (src/)       ${((appTicks / totalTicks) * 100).toFixed(1)}%  (${appTicks} ticks)`);
  lines.push(`  Benchmark harness         ${((benchTicks / totalTicks) * 100).toFixed(1)}%  (${benchTicks} ticks)`);
  lines.push(`  Dependencies (node_modules) ${((depTicks / totalTicks) * 100).toFixed(1)}%  (${depTicks} ticks)`);
  lines.push(`  Node.js internals         ${((nodeTicks / totalTicks) * 100).toFixed(1)}%  (${nodeTicks} ticks)`);
  lines.push(`  Other / native            ${((otherTicks / totalTicks) * 100).toFixed(1)}%  (${otherTicks} ticks)`);
  lines.push("");

  return lines.join("\n");
}

// -------------------------------------------------------------------------
// Main benchmark
// -------------------------------------------------------------------------
async function main() {
  console.log(`\n[benchmark] Mode: ${MODE}`);
  console.log(`[benchmark] Concurrency: ${CONCURRENCY}`);
  console.log(`[benchmark] Duration: ${DURATION_SEC}s`);
  console.log(`[benchmark] Payload: ${PAYLOAD_KB}KB`);
  console.log(`[benchmark] Base URL: ${BASE_URL}\n`);

  let service: ValkeyService;
  let realClient: { disconnect: () => Promise<void> } | null = null;

  if (MODE === "mock") {
    const mockClient = new MockValkeyClient();
    service = new ValkeyService(mockClient as any, BENCH_MANIFEST, logger);
  } else {
    // Real mode — ValkeyClient reads connection details from env vars:
    //   VALKEY_HOST, VALKEY_PORT, VALKEY_USERNAME, VALKEY_PASSWORD,
    //   VALKEY_USE_TLS=false, VALKEY_CLUSTER_MODE=false
    const { ValkeyClient } = await import("../src/core/client");
    realClient = new ValkeyClient(logger);
    service = new ValkeyService(realClient as any, BENCH_MANIFEST, logger);
    await (realClient as any).connect();
  }

  // Safety guard — if workers hang past the expected duration (e.g. stuck fetch,
  // unresponsive Valkey), this fires and terminates the process so it doesn't
  // sit waiting forever. .unref() means it won't prevent a normal exit.
  const wallTimeGuard = setTimeout(() => {
    console.error(`\n[benchmark] Wall time exceeded (${DURATION_SEC + 60}s) — forcing exit`);
    process.exit(1);
  }, (DURATION_SEC + 60) * 1000);
  wallTimeGuard.unref();

  const sampler = setInterval(sampleMemory, SAMPLE_INTERVAL_MS);
  sampleMemory();

  const startTime = Date.now();
  const endTime = startTime + DURATION_SEC * 1000;
  let running = true;
  let totalFired = 0;

  // Worker — fires requests in a tight loop until duration expires.
  // Status is inferred from the result shape:
  //   upstreamStatus absent               → data came from cache  → "hit"
  //   upstreamStatus present, data !null  → fetched live          → "miss"
  //   upstreamStatus present, data null   → upstream 4xx          → "bypass"
  async function worker(): Promise<void> {
    let localCount = 0;
    while (running && Date.now() < endTime) {
      const ep = ENDPOINTS[localCount % ENDPOINTS.length];
      localCount++;
      totalFired++;

      // Draw a random ID from the pool — each unique ID produces a distinct cache
      // key, giving a realistic mix of cold misses and warm hits rather than
      // hammering the same 5 static keys for the entire run.
      const id = ID_POOL[Math.floor(Math.random() * ID_POOL.length)];

      const reqStart = Date.now();
      try {
        const result = await service.getOrFetch(ep.prefix, {
          baseUrl: BASE_URL,
          queryParams: { id },
        });
        const elapsed = Date.now() - reqStart;

        if (result.upstreamStatus === undefined) {
          recordRequest(ep.prefix, "hit", elapsed);
        } else if (result.data !== null) {
          recordRequest(ep.prefix, "miss", elapsed);
        } else {
          recordRequest(ep.prefix, "bypass", elapsed);
        }
      } catch (err) {
        const elapsed = Date.now() - reqStart;
        if (err instanceof CircuitOpenError) {
          recordRequest(ep.prefix, "circuit_open", elapsed);
        } else {
          recordRequest(ep.prefix, "error", elapsed);
        }
      }
    }
  }

  // monitorEventLoopDelay uses V8's built-in event loop delay histogram.
  // resolution: 10ms — one sample bucket per 10ms interval.
  const elMonitor = monitorEventLoopDelay({ resolution: 10 });
  elMonitor.enable();

  // V8 CPU profiler — captures per-function tick counts during the benchmark.
  let profilerSession: Session | null = null;
  if (PROFILE) {
    profilerSession = new Session();
    profilerSession.connect();
    await profilerSession.post("Profiler.enable");
    await profilerSession.post("Profiler.start");
    console.log("[benchmark] CPU profiler started");
  }

  console.log(`[benchmark] Starting ${CONCURRENCY} workers...`);
  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);
  running = false;

  // Stop profiler and write results before any cleanup
  if (profilerSession) {
    const { profile } = await profilerSession.post("Profiler.stop");
    await profilerSession.post("Profiler.disable");
    profilerSession.disconnect();

    const cpuProfilePath = resolve(__dirname, "cpu.cpuprofile");
    writeFileSync(cpuProfilePath, JSON.stringify(profile));
    console.log(`[benchmark] CPU profile: ${cpuProfilePath}`);

    // Build a top-functions summary from the profile
    const summary = summarizeProfile(profile);
    const summaryPath = resolve(__dirname, "cpu-summary.txt");
    writeFileSync(summaryPath, summary);
    console.log(`[benchmark] CPU summary: ${summaryPath}`);
  }

  elMonitor.disable();
  sampleMemory();
  clearInterval(sampler);

  const actualDuration = (Date.now() - startTime) / 1000;

  // -----------------------------------------------------------------------
  // Compute summary from aggregated stats
  // -----------------------------------------------------------------------
  let totalRequests = 0;
  let hits = 0;
  let misses = 0;
  let errors = 0;
  let circuitOpens = 0;
  let latencySum = 0;
  const globalSample: number[] = [];

  for (const s of epStats.values()) {
    totalRequests += s.latencyCount;
    hits += s.hits;
    misses += s.misses;
    errors += s.errors;
    circuitOpens += s.circuitOpens;
    latencySum += s.latencySum;
    for (const v of s.latencySample) globalSample.push(v);
  }

  const avgLatency = totalRequests > 0 ? Math.round((latencySum / totalRequests) * 100) / 100 : 0;

  let peakHeap = 0;
  let peakRss = 0;
  let totalCpuMs = 0;
  for (const s of memorySamples) {
    if (s.heapUsedMB > peakHeap) peakHeap = s.heapUsedMB;
    if (s.rssMB > peakRss) peakRss = s.rssMB;
    totalCpuMs += s.cpuUserMs + s.cpuSystemMs;
  }

  const avgCpuPercent = Math.round((totalCpuMs / (actualDuration * 1000)) * 100 * 100) / 100;

  // Event loop lag — histogram values are in nanoseconds, convert to ms.
  const ns = (v: number) => Math.round((v / 1e6) * 100) / 100;
  const elLagP50Ms = ns(elMonitor.percentile(50));
  const elLagP95Ms = ns(elMonitor.percentile(95));
  const elLagP99Ms = ns(elMonitor.percentile(99));
  const elLagMaxMs = ns(elMonitor.max);

  // -----------------------------------------------------------------------
  // Build per-endpoint output (drop raw sample array — report recomputes
  // percentiles from the serialised sample)
  // -----------------------------------------------------------------------
  const endpointStats: BenchmarkResults["endpointStats"] = {};
  for (const [name, s] of epStats.entries()) {
    endpointStats[name] = {
      hits: s.hits,
      misses: s.misses,
      bypasses: s.bypasses,
      errors: s.errors,
      circuitOpens: s.circuitOpens,
      latencySum: s.latencySum,
      latencyCount: s.latencyCount,
      avgLatencyMs: s.latencyCount > 0 ? Math.round((s.latencySum / s.latencyCount) * 100) / 100 : 0,
      p50LatencyMs: percentile(s.latencySample, 50),
      p95LatencyMs: percentile(s.latencySample, 95),
      p99LatencyMs: percentile(s.latencySample, 99),
    };
  }

  const results: BenchmarkResults = {
    config: {
      mode: MODE,
      concurrency: CONCURRENCY,
      durationSec: DURATION_SEC,
      payloadKB: PAYLOAD_KB,
      keyPoolSize: KEY_POOL_SIZE,
      baseUrl: BASE_URL,
      cacheBackend: MODE === "real" ? "valkey (real)" : "in-memory map (mock)",
      upstreamBackend: "mock-server (http)",
      containerMemoryLimit: CONTAINER_MEMORY_LIMIT,
      containerCpuLimit: CONTAINER_CPU_LIMIT,
      v8HeapLimitMB: V8_HEAP_LIMIT_MB,
    },
    summary: {
      totalRequests,
      hits,
      misses,
      errors,
      circuitOpens,
      avgLatencyMs: avgLatency,
      p50LatencyMs: percentile(globalSample, 50),
      p95LatencyMs: percentile(globalSample, 95),
      p99LatencyMs: percentile(globalSample, 99),
      requestsPerSec: Math.round(totalRequests / actualDuration),
      peakHeapMB: peakHeap,
      peakRssMB: peakRss,
      avgCpuPercent,
      elLagP50Ms,
      elLagP95Ms,
      elLagP99Ms,
      elLagMaxMs,
    },
    memorySamples,
    endpointStats,
  };

  const outPath = resolve(__dirname, "results.json");
  writeFileSync(outPath, JSON.stringify(results));

  console.log(`\n[benchmark] Done. ${totalRequests.toLocaleString()} requests in ${actualDuration.toFixed(1)}s`);
  console.log(`[benchmark] Throughput: ${results.summary.requestsPerSec.toLocaleString()} req/sec`);
  console.log(`[benchmark] Hits: ${hits}, Misses: ${misses}, Errors: ${errors}, Circuit opens: ${circuitOpens}`);
  console.log(`[benchmark] Latency — avg: ${avgLatency}ms, p50: ${results.summary.p50LatencyMs}ms, p95: ${results.summary.p95LatencyMs}ms, p99: ${results.summary.p99LatencyMs}ms`);
  console.log(`[benchmark] Memory — peak heap: ${peakHeap}MB, peak RSS: ${peakRss}MB`);
  console.log(`[benchmark] CPU — avg: ${avgCpuPercent}%`);
  console.log(`[benchmark] Event loop lag — p50: ${elLagP50Ms}ms, p95: ${elLagP95Ms}ms, p99: ${elLagP99Ms}ms, max: ${elLagMaxMs}ms`);
  console.log(`[benchmark] Results: ${outPath}`);
  console.log(`[benchmark] Report:  npx tsx benchmarks/report.ts\n`);

  clearTimeout(wallTimeGuard);

  // Disconnect the Glide native client — it holds Rust-backed thread handles that
  // keep the Node.js event loop alive. Without this, the process won't exit naturally
  // in real mode and relies solely on process.exit(0) to force-terminate.
  if (realClient) {
    await realClient.disconnect().catch(() => {});
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[benchmark] Fatal:", err);
  process.exit(1);
});
