# Benchmarks

The benchmark suite measures how `ValkeyService` performs under sustained concurrent load against a real Valkey instance. It captures throughput, latency distribution, cache hit/miss rates, memory usage, and CPU consumption — numbers you can use to validate behaviour across different pod sizes before a deployment.

---

## Directory layout

```
benchmarks/
  mock-server.ts   — fake upstream API (configurable payload, latency, failure rate)
  run.ts           — benchmark driver (fires concurrent workers, collects metrics)
  report.ts        — reads results.json, writes report.html
  Dockerfile       — image used by docker-compose for all benchmark containers
  results.json     — output of the last custom-runner run (overwritten each time)
  report.html      — generated HTML report for custom runner (open in browser)
  k6/
    load-test.js   — k6 load test script
    app-server.ts  — thin HTTP server wrapping ValkeyService (target for k6)
    report.mjs     — reads k6 results, writes k6/results/report.html
    Dockerfile.app — image for the app server container
    results/       — k6 output (k6-raw.json, k6-results.json, report.html, report.md)

bench.env              — shared configuration (edit here, picked up by all services)
docker-compose.yml     — defines valkey, mock-server, benchmark-small, benchmark-standard
docker-compose.k6.yml  — k6 load test suite (mock and real upstream profiles)
```

---

## How it works

```
bench.env
    |
    +-- PAYLOAD_KB, LATENCY_MS, FAILURE_RATE, DURATION_SEC
    |
    v
docker-compose up --profile small|standard
    |
    +-- valkey container         (real Valkey 8, 256MB maxmemory)
    |
    +-- mock-server container    (fake upstream HTTP API)
    |       reads PAYLOAD_KB, LATENCY_MS, FAILURE_RATE from bench.env
    |       responds to every path with a pre-generated JSON payload
    |
    +-- benchmark container      (run.ts)
            reads PAYLOAD_KB, DURATION_SEC, CONCURRENCY from bench.env / compose
            creates ValkeyService pointed at the real Valkey container
            fires N concurrent workers for DURATION_SEC seconds
            each worker calls getOrFetch() in a tight loop, cycling through
            the 5 routes in BENCH_MANIFEST
            aggregates metrics in-flight (no unbounded arrays)
            writes benchmarks/results.json via volume mount → appears on host
```

After the run, generate the report locally:

```bash
npx tsx benchmarks/report.ts
open benchmarks/report.html
```

---

## Configuration — bench.env

All shared parameters live in `bench.env` at the repo root. Both the mock server and the benchmark runner read from it, so a change here affects both.

| Variable | Default | What it controls |
|---|---|---|
| `PAYLOAD_KB` | `1` | Size of the JSON payload the mock server returns per response |
| `LATENCY_MS` | `50` | Artificial delay the mock server adds before replying (simulates upstream response time) |
| `FAILURE_RATE` | `0` | Fraction of upstream requests that return 503 (e.g. `0.1` = 10% failure rate) |
| `DURATION_SEC` | `30` | How long each benchmark run lasts |
| `KEY_POOL_SIZE` | `500` | Number of unique IDs in the key pool. Each ID produces a distinct cache key via `queryParams`, giving a realistic mix of cold misses and warm hits. Lower values mean a warmer cache (more hits); higher values mean more unique keys and more upstream fetches |

Parameters that differ between profiles (concurrency, memory limits, CPU limits) are set directly in `docker-compose.yml` and are not in `bench.env`.

---

## Profiles

Two profiles mirror typical k8s pod sizes:

| Profile | Memory limit | CPU limit | V8 heap cap | Concurrency |
|---|---|---|---|---|
| `small` | 512MB | 0.5 vCPU | 384MB | 100 workers |
| `standard` | 1GB | 1.0 vCPU | 896MB | 200 workers |

```bash
# small pod
docker compose --profile small up --build --abort-on-container-exit

# standard pod
docker compose --profile standard up --build --abort-on-container-exit
```

---

## What is mocked vs real

Understanding this is important when reading the results.

| Component | What it is | Why |
|---|---|---|
| **Valkey** | Real — `valkey/valkey:8-alpine` container | The whole point is to measure actual cache behaviour: serialization, TCP round trips, connection pool pressure |
| **Upstream API** | Mocked — `mock-server.ts` HTTP server | Your real services (`nmlvhub-ms-userprofile`, `nmlvhub-ms-field`, etc.) are not available in a local benchmark environment. The mock server replaces them with a configurable stand-in |
| **ValkeyService** | Real — same code that ships in the library | No stubs. The benchmark exercises the full path: key hashing, msgpackr serialization, circuit breaker, concurrency limiter, p-limit queue |

The mock server serves every route with the same pre-generated payload. It does not distinguish between endpoints — the benchmark is not testing routing logic, it is testing cache performance under load.

---

## Benchmark manifest

`run.ts` defines a `BENCH_MANIFEST` that mirrors `SERVICES_MANIFEST` from `src/config/manifest.ts`:

| Prefix | Service name | Path |
|---|---|---|
| `getUserProfileByLoginId` | `nmlvhub-ms-userprofile` | `/profile/loginid` |
| `getUserProfileByNMU` | `nmlvhub-ms-userprofile` | `/profile/` |
| `getFieldDetailsByFieldNMU` | `nmlvhub-ms-field` | `/field/` |
| `getCXAuthProfile` | `ms-authprofile-v2` | `/v1/auth-profile` |
| `mockService` | `mock-service` | `/mock-service` |

Workers cycle through these routes in round-robin order. All routes resolve to the mock server at `http://mock-server:4000`.

---

## Metrics collected

### Summary (written to results.json, shown in report)

| Metric | Description |
|---|---|
| Total requests | All requests fired during the run |
| Throughput | Requests per second over the full duration |
| Cache hits | Requests served from Valkey (no upstream call) |
| Cache misses | Requests that fell through to the upstream API |
| Bypasses | Requests where upstream returned 4xx (not cached, not an error) |
| Errors | Requests that threw an unexpected error |
| Circuit opens | Requests rejected because the circuit breaker was open |
| Avg / p50 / p95 / p99 latency | End-to-end latency from `getOrFetch()` call to result |
| Peak heap | Highest `heapUsed` reading during the run |
| Peak RSS | Highest RSS reading during the run |
| Avg CPU | Total CPU time (user + system) as a percentage of wall clock duration |

### Per-endpoint breakdown

The same hit/miss/error/circuit-open counts and avg/p50/p95/p99 latency figures, split by route prefix. Useful for spotting if one service name's circuit breaker is tripping while others are healthy.

### Memory samples

Process memory (`heapUsed`, `heapTotal`, `rss`, `external`, `arrayBuffers`) and CPU delta sampled every 200ms throughout the run. Stored in `results.json` but not currently shown in the report — available if you need to add timeline analysis.

---

## How metrics are collected

### Latency

Rather than storing a per-request object for every request (which would exhaust memory at high concurrency), latency values are held in a fixed-size reservoir sample per endpoint using [Algorithm R](https://en.wikipedia.org/wiki/Reservoir_sampling). The reservoir is capped at 10,000 entries per endpoint. This gives statistically representative p50/p95/p99 percentiles without unbounded memory growth.

Exact counts (hits, misses, errors, etc.) are maintained as plain integer counters — no sampling involved there.

### Status inference

`ValkeyService.getOrFetch()` returns `{ data, upstreamStatus? }`, not a named status field. The benchmark infers status from the shape of the result:

| Result shape | Inferred status |
|---|---|
| `upstreamStatus` absent | `hit` — data came from Valkey cache |
| `upstreamStatus` present, `data` non-null | `miss` — fetched from upstream, cached |
| `upstreamStatus` present, `data` null | `bypass` — upstream returned 4xx, not cached |
| `CircuitOpenError` thrown | `circuit_open` — circuit breaker rejected the request |
| Any other throw | `error` |

---

## Reading the results

### Hit rate

After the first cold-start pass (one miss per unique cache key to populate Valkey), all subsequent requests for the same key should be hits. With only 5 routes in the manifest, you should see a hit rate above 99% after the first few seconds. A lower hit rate suggests TTL expiry or key collision issues.

### Latency spread: p50 vs p95/p99

Cache hits go directly to Valkey — expect p50 in the low single-digit milliseconds. Cache misses go to the mock server which adds `LATENCY_MS` of delay — expect p95/p99 to reflect that. A large gap between p50 and p95 (e.g. 5ms vs 90ms) is normal and expected; it represents the cost of the occasional miss hitting a slow upstream.

If p95 is high and your hit rate is also high, the tail latency is likely coming from Valkey connection queueing under concurrency pressure, not upstream fetches.

### Memory

Peak heap reflects the overhead of the library itself under load — connection state, msgpackr buffers, circuit breaker state, the p-limit queue. It should stay well below the V8 heap cap for the profile. If it approaches the cap, the garbage collector will thrash and latency will spike.

### CPU

CPU is reported as a percentage of wall clock time. 100% means one full core consumed. On a `0.5 vCPU` container, sustained CPU above ~45% means you are close to saturating the available compute. High CPU with low throughput usually points to serialization overhead (msgpackr encoding/decoding large payloads).

---

## Circuit breaker testing

Set `FAILURE_RATE` in `bench.env` to a value greater than `0` to inject upstream failures:

```bash
# bench.env
FAILURE_RATE=0.3   # 30% of cache misses return 503
```

The opossum circuit breaker in `ValkeyService` is keyed per `serviceName`. Routes sharing a service name share a breaker — so `getUserProfileByLoginId` and `getUserProfileByNMU` (both `nmlvhub-ms-userprofile`) will trip together. Once the error threshold is crossed, subsequent requests for that service are rejected immediately with `CircuitOpenError` and appear as `circuit_open` in the report.

---

## npm scripts

| Script | What it does |
|---|---|
| `bench:small` | Runs the custom benchmark in Docker with the `small` profile (512MB / 0.5 CPU). Results: `benchmarks/results.json` / `benchmarks/report.html` |
| `bench:standard` | Runs the custom benchmark in Docker with the `standard` profile (1GB / 1 CPU). Results: `benchmarks/results.json` / `benchmarks/report.html` |
| `bench:k6` | Runs the k6 load test against a mock upstream. Results: `benchmarks/k6/results/` |
| `bench:k6:real` | Runs the k6 load test against a real upstream (requires `GATEWAY_URL`). Results: `benchmarks/k6/results/` |
| `bench:k6:report` | Reads k6 output and writes `benchmarks/k6/results/report.html` |

After a k6 run, open the report:

```bash
open benchmarks/k6/results/report.html
```

After a custom runner (`bench:small` / `bench:standard`) run, open the report:

```bash
open benchmarks/report.html
```
