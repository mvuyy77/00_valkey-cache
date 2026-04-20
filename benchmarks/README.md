# Benchmarks

Load test suite for `ValkeyService`. Measures throughput, latency distribution, cache hit/miss rates, memory, and CPU under sustained concurrent load against a real Valkey instance.

## Files

| File | Purpose |
|---|---|
| `run.ts` | Benchmark driver — spins up concurrent workers, fires `getOrFetch()` calls, collects metrics |
| `mock-server.ts` | Fake upstream HTTP API — configurable payload size, latency, and failure rate |
| `report.ts` | Reads `results.json`, writes `report.html` |
| `Dockerfile` | Image used by Docker Compose for all benchmark containers |
| `results.json` | Output of the last run (overwritten each time) |
| `report.html` | Generated HTML report — open in a browser |

## Quick start

All shared config lives in `bench.env` at the repo root. Edit values there, then run:

```bash
# small pod (512MB / 0.5 CPU / 100 workers)
docker compose --profile small up --build --abort-on-container-exit

# standard pod (1GB / 1 CPU / 200 workers)
docker compose --profile standard up --build --abort-on-container-exit
```

The HTML report is generated automatically at the end of each run and written to `benchmarks/report.html` via the volume mount. Open it with:

```bash
open benchmarks/report.html
```

Or regenerate it manually from an existing `results.json`:

```bash
npm run bench:report
```

## Configuration

All shared parameters live in `bench.env` at the repo root. A change there is picked up by every service — mock server and benchmark runner — without touching `docker-compose.yml`.

| Variable | Default | What it controls |
|---|---|---|
| `PAYLOAD_KB` | `1` | JSON payload size the mock server returns per response |
| `LATENCY_MS` | `50` | Artificial delay the mock server adds before replying (simulates upstream latency) |
| `FAILURE_RATE` | `0` | Fraction of upstream requests that return 503 — e.g. `0.3` = 30% failure rate |
| `DURATION_SEC` | `30` | How long each run lasts |
| `KEY_POOL_SIZE` | `500` | Number of unique IDs in the key pool. Each ID becomes a distinct cache key, giving a realistic mix of cold misses and warm hits. Lower = warmer cache; higher = more upstream fetches |

Parameters that differ between profiles (concurrency, resource limits) are set directly in `docker-compose.yml`.

## How the key pool works

Without a key pool, the benchmark would cycle through 5 static routes with no query variation — only 5 unique cache keys for the entire run. After the first 5 requests warm the cache, every subsequent request is a hit, regardless of load.

With `KEY_POOL_SIZE=500`, each worker draws a random ID per request and passes it as `queryParams: { id }`. Since the cache key is derived from the full URL, each unique ID is a distinct key. This produces:

- A cold-start phase where the first pass through the pool generates misses and populates the cache
- A steady-state phase with a realistic hit/miss ratio
- Real concurrent-miss pressure: multiple workers missing different keys simultaneously exercises the concurrency limiter and `requestsInFlight` deduplication

To simulate a hot-key scenario (mostly hits), lower `KEY_POOL_SIZE`. To stress the miss path (more upstream fetches), raise it.

## Profiles

| Profile | Memory | CPU | V8 heap cap | Concurrency |
|---|---|---|---|---|
| `small` | 512MB | 0.5 vCPU | 384MB | 100 workers |
| `standard` | 1GB | 1.0 vCPU | 896MB | 200 workers |

## What is real vs mocked

| Component | Reality | Reason |
|---|---|---|
| **Valkey** | Real — `valkey/valkey:8-alpine` container | The whole point is to measure actual cache behaviour: serialization, TCP round trips, connection pool pressure |
| **Upstream API** | Mocked — `mock-server.ts` | Real downstream services are not available in a local benchmark environment. The mock server is a configurable stand-in |
| **ValkeyService** | Real — same code that ships | No stubs. The benchmark exercises the full path: key hashing, msgpackr serialization, circuit breaker, concurrency limiter, p-limit queue |

## Circuit breaker testing

Set `FAILURE_RATE` in `bench.env` to inject upstream failures:

```
# bench.env
FAILURE_RATE=0.3   # 30% of upstream requests return 503
```

Routes that share a `serviceName` share a circuit breaker. For example, `getUserProfileByLoginId` and `getUserProfileByNMU` both use `nmlvhub-ms-userprofile` — if that breaker trips, both endpoints are blocked simultaneously. Tripped requests appear as `circuit_open` in the report.

## Latency metrics

Latency is tracked using reservoir sampling (Algorithm R) with a cap of 10,000 samples per endpoint. This keeps memory bounded regardless of total request count while producing statistically representative p50/p95/p99 percentiles.

What to expect:

- **p50**: cache hits going straight to Valkey — single-digit milliseconds
- **p95/p99**: occasional misses hitting the mock server — will reflect `LATENCY_MS`
- **Large p50 vs p95 gap**: normal. It represents the cost of a cold miss vs a warm hit
- **High p95 with a high hit rate**: Valkey connection queueing under concurrency pressure, not upstream latency
