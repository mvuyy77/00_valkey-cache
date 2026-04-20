# k6 Benchmark Report

**Run:** 2026-04-20T00:38:57.285Z

## Configuration

| Parameter | Value |
|---|---|
| Target | `http://app-server-mock:3000` |
| Scenario | all |
| VUs | 200 |
| Duration (sustained phase) | 30s |
| Key pool | 500 |
| Upstream | `http://mock-server:4000` |
| Declared payload size | 1 KB |
| Container memory limit | 1g |
| Container CPU limit | 1.0 |
| Node heap limit | 896 MB |
| Compression threshold | 1024 B |

## Load

| Metric | Value |
|---|---|
| Total requests | 817,827 |
| Throughput | 9619.4 req/s |
| Cache hits | 815,174 |
| Cache misses | 2,651 |
| Cache hit rate | 99.68% |
| Error rate | 0.00% |

## Observed Response Payload

| Metric | Value |
|---|---|
| Responses measured | 817,825 |
| Avg size | 0.99 KB (1,011 B) |
| Min size | 0.99 KB |
| Max size | 0.99 KB |
| Total bytes served | 788.5 MB |

## End-to-end Latency (HTTP from k6's perspective)

| Percentile | Latency |
|---|---|
| min | 0.21 ms |
| p50 (median) | 11.81 ms |
| avg | 21.97 ms |
| p90 | 53.06 ms |
| p95 | 63.26 ms |
| p99 | 80.35 ms |
| max | 619.13 ms |

## Event Loop Lag (app-server process)

High values mean the Node.js event loop is blocked — callbacks queue up,
and user-facing latency tail grows. p99 > 50 ms is a red flag.

| Percentile | Lag |
|---|---|
| min | 6.30 ms |
| mean | 15.60 ms |
| p50 | 11.08 ms |
| p90 | 36.01 ms |
| p95 | 45.12 ms |
| p99 | 59.15 ms |
| max | 93.00 ms |
| stddev | 11.57 ms |

## Memory (app-server process, final snapshot)

| Metric | Value |
|---|---|
| RSS (resident) | 156.9 MB |
| Heap used | 16.3 MB |
| Heap total | 19.0 MB |
| External (Buffers etc.) | 5.5 MB |
| ArrayBuffers | 0.1 MB |

## Garbage Collection (app-server process)

| Metric | Value |
|---|---|
| GC cycles | 6,449 |
| Total GC time | 9143.40 ms |
| Avg pause | 1.42 ms |
| GC time as % of uptime | 9.00% |

## Thresholds

No thresholds reported.

## Files

- `results/k6-results.json` — structured k6 summary
- `results/k6-raw.json` — every k6 data point (for post-processing)
- `results/report.html` — k6 interactive dashboard (time-series charts)
- `results/app-metrics.json` — app-server process metrics
- `results/report.md` — this file
