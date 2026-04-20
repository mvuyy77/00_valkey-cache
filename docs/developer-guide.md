# Developer Guide

This guide is for developers working **on** this library — adding features, fixing bugs, changing the manifest, and validating those changes locally before review. If you are a consumer integrating the library into an app, read [docs/index.md](index.md) instead.

---

## Table of contents

1. [Prerequisites](#prerequisites)
2. [First-time setup](#first-time-setup)
3. [Project layout](#project-layout)
4. [Architecture overview](#architecture-overview)
5. [Three ways to verify changes](#three-ways-to-verify-changes)
6. [Unit tests](#unit-tests)
7. [Local dev playground](#local-dev-playground)
8. [Benchmarks](#benchmarks)
9. [Common tasks](#common-tasks)
10. [PR and release workflow](#pr-and-release-workflow)
11. [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool | Why |
|------|-----|
| Node.js ≥ 22 | `response.bytes()` is used in `performFetch` — not available below Node 22 |
| Docker Desktop | Runs Valkey locally for the dev playground |
| npm | Package management |

No Valkey install required on the host — Docker handles it.

---

## First-time setup

```bash
# 1. Install dependencies
npm install

# 2. Copy the dev env file (already committed — no changes needed for local dev)
# .env.dev contains: VALKEY_HOST=localhost, VALKEY_PORT=6379, VALKEY_USE_TLS=false, VALKEY_CLUSTER_MODE=false

# 3. Start Valkey (runs in the background via Docker)
npm run dev:up

# 4. In a separate terminal, start the mock server
npm run dev:mock

# 5. Run the playground to confirm everything connects
npm run dev
```

Expected output:

```
=== Valkey Dev Playground ===
Valkey: UP (0.015s)

[✓] Cache miss then hit
[✓] Header-based cache key isolation
[✓] POST body canonicalization (key order shouldn't matter)
[✓] Different POST bodies → different cache entries
[✓] Circuit breaker opens after sustained failures
[✓] Slow upstream responds within timeout

────────────────────────────────────────
Passed: 6  Failed: 0
────────────────────────────────────────
```

---

## Project layout

```
.
├── src/
│   ├── index.ts              Public entry point — the ValkeyCacheWrapper singleton
│   ├── config/
│   │   ├── manifest.ts       Service manifest — all registered upstream routes
│   │   └── schema.ts         Zod schema for Valkey connection config + defaults
│   ├── core/
│   │   ├── client.ts         ValkeyClient — glide connection management
│   │   └── service.ts        ValkeyService — cache-aside logic, circuit breakers, serialization
│   └── types/
│       └── types.ts          All shared types and error classes
│
├── tests/
│   ├── client.test.ts        ValkeyClient unit tests
│   ├── service.test.ts       ValkeyService unit tests (cache key generation, getOrFetch, circuit breaker)
│   ├── index.test.ts         ValkeyCacheWrapper integration-style tests (singleton lifecycle)
│   └── schema.test.ts        Zod config schema tests
│
├── scripts/
│   ├── dev.ts                Dev playground — runs named scenarios against a live Valkey
│   └── mock-server.ts        Lightweight HTTP server that the playground fetches from
│
├── benchmarks/               Load and throughput benchmarks (separate from unit tests)
│   ├── mock-server.ts        Benchmark-specific mock server (do not use for dev)
│   ├── run.ts                Custom benchmark runner
│   └── k6/                   k6 load test suite
│
├── docs/                     Reference docs for each module
│   ├── index.md              ValkeyCacheWrapper (public API)
│   ├── service.md            ValkeyService (internals)
│   ├── client.md             ValkeyClient (internals)
│   └── benchmarks.md         Benchmark results and analysis
│
├── .env.dev                  Local env vars (Valkey connection for dev/playground)
├── bench.env                 Env vars for benchmark runs
├── docker-compose.dev.yml    Dev: Valkey only (mock server runs on host)
├── docker-compose.yml        Benchmarks: Valkey + mock server + benchmark runner
├── docker-compose.k6.yml     k6 load test suite
├── vitest.config.ts          Vitest config — includes tests/, excludes types + manifest
├── tsconfig.json             TypeScript config (rootDir: src, outDir: dist)
└── tsdown.config.ts          Build config (tsdown bundles for distribution)
```

---

## Architecture overview

```
Consumer app
    │
    │  import { ValkeyCacheWrapper, ServiceManifest }
    ▼
src/index.ts  (ValkeyCacheWrapper singleton)
    │
    │  delegates to
    ▼
src/core/service.ts  (ValkeyService)
    │
    ├──── cache lookup ──────► src/core/client.ts  (ValkeyClient)
    │                               │
    │                               └──► @valkey/valkey-glide  (GlideClient / GlideClusterClient)
    │
    └──── origin fetch ──────► opossum circuit breaker
                                    │
                                    └──► upstream API (via native fetch)
```

### Request flow

```
getOrFetch(prefix, ctx)
  │
  ├─ coalesce: if same cache key is in-flight, return existing Promise
  │
  ├─ generate cache key  (sha256 of prefix + method + url + selected headers + body)
  │
  ├─ connect to Valkey
  │     └─ if connected + TTL > 0: check cache
  │             └─ HIT  → gunzip → unpack (msgpack) → return data
  │             └─ MISS → continue
  │
  ├─ check p-limit queue (max 100 concurrent, 500 queued → 503)
  │
  └─ circuit breaker → performFetch → origin API
        └─ 2xx  → JSON.parse → pack (msgpack) → gzip if ≥1KB → setToCache (fire-and-forget)
        └─ 4xx  → pass through or throw (see HTTP status table in service.md)
        └─ 5xx  → throw (breaker counts it)
```

### Key design decisions

**Why singleton (`src/index.ts`)?**
One Valkey connection pool per process. Multiple pools waste sockets, break in-flight deduplication, and fragment circuit breaker state. See [docs/index.md — Why a singleton?](index.md#why-a-singleton) for the full reasoning.

**Why `serviceName` on breakers, not prefix?**
Two manifest entries that both point at `svc-userprofile` share one breaker. If `GET /profile/loginid` starts failing, the breaker trips and also blocks `GET /profile/nmu` — because both routes call the same upstream. Independent services get independent breakers.

**Why msgpack + gzip?**
msgpack is ~30% smaller than JSON and deserializes faster. gzip on top for payloads ≥1KB drops size further. Below 1KB, gzip overhead exceeds the saving. Reads attempt gunzip first and fall back to raw msgpack for backward compatibility with keys written before compression was introduced.

**Why canonical JSON for POST body cache keys?**
`{a:1, b:2}` and `{b:2, a:1}` are logically identical. Without key sorting, they'd produce different cache keys and miss each other. The replacer in `JSON.stringify` sorts keys recursively.

---

## Three ways to verify changes

| Method | What it catches | Speed | Requires Docker |
|--------|-----------------|-------|-----------------|
| Unit tests (`npm test`) | Logic bugs, regressions, type errors | Fast (~2s) | No |
| Dev playground (`npm run dev`) | End-to-end wiring, Valkey behavior, real network | Medium (~5s) | Yes |
| Benchmarks (`npm run bench:k6`) | Throughput regressions, latency changes | Slow (~5min) | Yes |

For most changes, unit tests + playground is sufficient. Run benchmarks only when touching hot-path code in `service.ts` or when a PR claims a performance improvement.

---

## Unit tests

```bash
npm test              # run once
npm run test:watch    # re-run on file save (best while writing tests)
npm run test:coverage # run + open HTML coverage report
```

Tests live in `tests/` and are organized by module:

| File | Covers |
|------|--------|
| `service.test.ts` | `generateCacheKey` (all variants), `getOrFetch` (hit/miss/error/breaker), concurrency dedup |
| `client.test.ts` | Config validation, lazy connect, connection dedup, self-healing, auto-retry |
| `index.test.ts` | Singleton lifecycle (init/close/re-init), error propagation |
| `schema.test.ts` | Zod schema defaults, coercions, required-field errors |

### Test patterns

**Private method access**

`generateCacheKey` is private — tests reach it via a typed cast rather than making it public:

```ts
type PrivateSurface = {
    generateCacheKey: (prefix: string, ctx: RequestContext) => string;
};
const reachPrivate = (service: ValkeyService): PrivateSurface =>
    service as unknown as PrivateSurface;
```

This is intentional — the method is an implementation detail of `getOrFetch`. The cast is localized so test bodies stay readable without leaking the pattern into production types.

**Mocking**

Tests mock at the boundary closest to what they're testing:

- `service.test.ts` — mocks `ValkeyClient` via `vi.mock`, `global.fetch` for origin calls
- `client.test.ts` — mocks `GlideClusterClient.createClient` and `GlideClient.createClient`
- `index.test.ts` — mocks `ValkeyService` methods

### Coverage exclusions

`vitest.config.ts` explicitly excludes from coverage:

- `src/types/**` — no logic, only type declarations
- `src/config/manifest.ts` — configuration data, not logic
- `src/index.ts` — singleton wiring tested via integration tests
- `src/playground/*` — scratch files, not shipped

---

## Local dev playground

The playground (`scripts/dev.ts`) is the primary tool for testing changes locally against a real Valkey instance and a real HTTP upstream. It bypasses the `ValkeyCacheWrapper` singleton and constructs `ValkeyService` directly — this means you can test with any manifest config without touching the public API or the production manifest.

### Starting the stack

Two terminals required:

```bash
# Terminal 1 — keep running while developing
npm run dev:up    # start Valkey in Docker (background, persists across runs)
npm run dev:mock  # start mock server on host at :4000 (restart when mock-server.ts changes)

# Terminal 2 — run after each change
npm run dev          # run playground once
npm run dev:watch    # re-run playground on every file save (fastest dev loop)
npm run dev:reset    # flush all Valkey keys (wipe state so you see real cache misses)
npm run dev:down     # stop Valkey when done for the day
```

### Why the mock server runs on the host (not Docker)

The mock server (`scripts/mock-server.ts`) uses `tsx` which depends on `esbuild`. `esbuild` ships platform-specific native binaries. When you mount your `node_modules` from macOS into a Linux container, the macOS esbuild binary can't execute — you get a `TransformError`. Running on the host avoids this entirely.

The benchmark mock server (`benchmarks/mock-server.ts`) works in Docker because it builds fresh inside a container that runs `npm install` for Linux. For day-to-day dev work, the host approach is simpler.

### Mock server routes

```
GET  /mock/user    → 200 JSON  { route, user: { id, name }, ts }
POST /mock/search  → 200 JSON  { route, received: <echoed body>, ts }
GET  /mock/slow    → 200 JSON after LATENCY_MS (default 200ms)
GET  /mock/fail    → 503 JSON  { error: "Service Unavailable" }
```

Configure latency:
```bash
LATENCY_MS=500 npm run dev:mock
```

### Playground anatomy

`scripts/dev.ts` has three parts:

**1. Test manifest** — inline manifest entries that map to mock server routes. Add an entry here when you need to test a new behavior:

```ts
const testManifest: Record<string, ServiceManifestConfig> = {
    "mock-user": {
        serviceName: "mock-happy-svc",
        method: "GET",
        relativePath: "/mock/user",
        TTLInSeconds: 30,
        apiFetchTimeoutInSeconds: 5,
        cacheKeyHeaders: ["x-tenant"],
    },
    // add your entry here
};
```

**2. `scenario()` runner** — wraps each test in try/catch, prints `[✓]` or `[✗]`, and continues running even if one fails:

```ts
await scenario("My new scenario", async () => {
    const result = await service.getOrFetch("my-prefix", ctx);
    assert(result.data !== null, "Expected data");
});
```

**3. `assert()`** — throws with a message on failure. Keep assertions specific so failures are self-diagnosing.

### Adding a scenario for your change

1. Add an entry to `testManifest` if needed.
2. Add a mock server route to `scripts/mock-server.ts` if needed (restart `npm run dev:mock` after changes).
3. Call `npm run dev:reset` so cached state from previous runs doesn't mask misses.
4. Add a `scenario()` block.

Example — testing a new header:

```ts
// In testManifest:
"mock-with-role": {
    serviceName: "mock-happy-svc",
    method: "GET",
    relativePath: "/mock/user",
    TTLInSeconds: 30,
    apiFetchTimeoutInSeconds: 5,
    cacheKeyHeaders: ["x-role"],   // ← your new header
},

// In run():
await scenario("x-role header produces distinct cache entries", async () => {
    const admin: RequestContext = { baseUrl: BASE, headers: { "x-role": "admin" } };
    const guest: RequestContext = { baseUrl: BASE, headers: { "x-role": "guest" } };

    const r1 = await service.getOrFetch("mock-with-role", admin);
    assert(r1.upstreamStatus === 200, "admin: expected upstream fetch");

    await new Promise(r => setTimeout(r, 50));  // let cache write settle

    const r2 = await service.getOrFetch("mock-with-role", guest);
    assert(r2.upstreamStatus === 200, "guest: should miss (different key)");

    const r3 = await service.getOrFetch("mock-with-role", admin);
    assert(r3.upstreamStatus === undefined, "admin second call: should HIT");
});
```

### Circuit breaker testing in the playground

The `mock-fail` manifest entry uses reduced thresholds so the breaker trips quickly in dev:

```ts
"mock-fail": {
    serviceName: "mock-fail-svc",
    circuitBreakerOptions: { volumeThreshold: 10, allowWarmUp: false },
    ...
}
```

In production, all services use the defaults (`volumeThreshold: 100`, `allowWarmUp: true`). The `circuitBreakerOptions` field on `ServiceManifestConfig` lets you override per service — this is also useful when a real upstream is known to be more or less resilient than the defaults assume.

**Important**: use `queryParams` (not `uri`) to generate distinct cache keys when firing multiple requests to the same prefix in a loop. `uri` appends to the path, which changes the route and may not match your mock server handler:

```ts
// Correct — /mock/fail?id=0 still routes to /mock/fail
{ baseUrl: BASE, queryParams: { id: String(i) } }

// Wrong — /mock/fail/0 won't match the exact-path handler
{ baseUrl: BASE, uri: `/${i}` }
```

### Cache write timing

The cache write in `getOrFetch` is fire-and-forget (`setToCache` is not awaited). After a cache miss that fetches from upstream, add a short delay before asserting a HIT on the same key:

```ts
const r1 = await service.getOrFetch("mock-user", ctx);  // miss → upstream fetch + async write
await new Promise(r => setTimeout(r, 50));               // let the write settle
const r2 = await service.getOrFetch("mock-user", ctx);  // should HIT
assert(r2.upstreamStatus === undefined, "expected HIT");
```

---

## Benchmarks

Benchmarks are independent of the unit tests and playground. Run them only when evaluating throughput or latency impact.

```bash
# k6 load test (recommended — most realistic)
npm run bench:k6           # mock upstream
npm run bench:k6:real      # real upstream (requires live GATEWAY_URL)

# Custom benchmark runner
npm run bench:small        # quick validation run
npm run bench:standard     # full benchmark suite
```

Configuration is in `bench.env`:

```bash
PAYLOAD_KB=1024      # payload size per upstream response
KEY_POOL_SIZE=500    # unique cache keys (higher = more misses on first pass)
LATENCY_MS=50        # simulated upstream latency
FAILURE_RATE=0       # fraction of requests that fail (0.0–1.0)
DURATION_SEC=30      # how long each run lasts
```

Results location:
- **k6** (`bench:k6`, `bench:k6:real`): `benchmarks/k6/results/` — open `benchmarks/k6/results/report.html`
- **Custom runner** (`bench:small`, `bench:standard`): `benchmarks/results.json` + `benchmarks/report.html`

See [docs/benchmarks.md](benchmarks.md) for analysis of current numbers.

---

## Common tasks

### Adding a new upstream service

1. **Add the enum value** to `ServiceManifest` in `src/types/types.ts`:

    ```ts
    export enum ServiceManifest {
        // existing entries ...
        NEW_SERVICE = "getNewService",
    }
    ```

2. **Add the manifest entry** to `SERVICES_MANIFEST` in `src/config/manifest.ts`:

    ```ts
    [ServiceManifest.NEW_SERVICE]: {
        serviceName: "ms-new-service",        // shared breaker key — use the upstream service name
        method: "GET",
        relativePath: "/v1/new-resource",
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5,
        cacheKeyHeaders: ["x-tenant"],        // only if the response varies by tenant
    },
    ```

3. **Verify locally** — add an entry to `testManifest` in `scripts/dev.ts` pointing at `/mock/user` (or add a new mock route), write a scenario, and run `npm run dev`.

4. **Write or update a unit test** if the new entry has unusual behavior (e.g., path params, body caching, custom TTL).

5. **Check semver** — adding a new entry is a **minor** bump (additive). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full table.

### Changing an existing manifest entry

Changing `relativePath`, `method`, `TTLInSeconds`, or `apiFetchTimeoutInSeconds` on an existing entry is a **major** bump — callers observing different cache lifetimes or different upstream routes is a silent behavior change. Add a changelog entry and call it out in the PR description.

### Changing `ValkeyService` internals

`service.ts` is the hot path. Guidelines:

- Changes to `generateCacheKey` invalidate all existing cache keys — every key written before the change becomes a permanent miss until TTL expires. Flag this in the PR.
- Changes to serialization (msgpack packing format, gzip threshold) may create backward compatibility issues if old keys exist in Valkey. The current pattern (try gunzip, fall back to raw msgpack) was added for exactly this reason — follow the same pattern if you change the format.
- Changes to the circuit breaker defaults (`volumeThreshold`, `errorThresholdPercentage`, etc.) are **major** — observable behavior changes even though consumer code doesn't.

### Changing connection config (`ValkeyClient`)

Changing `requestTimeout`, `connectionTimeout`, `inflightRequestsLimit`, or `connectionBackoff` affects how the client behaves under load and failure. These changes require a benchmark run to confirm the new behavior doesn't regress throughput.

### Adding a public type

Adding an optional field to an existing interface is a **minor** bump. Adding a required field or removing/renaming anything is **major**. Adding a new interface or type is **minor**.

---

## PR and release workflow

### Before opening a PR

```bash
npm run typecheck          # tsc --noEmit — catches type errors not caught by tsx at dev time
npm test                   # all unit tests pass
npm run dev                # playground scenarios all pass
```

### Determining semver bump

| Change | Bump |
|--------|------|
| Add manifest entry / enum value | minor |
| Add optional type field | minor |
| Change `relativePath`, `method`, TTL, or timeout on existing entry | **major** |
| Remove manifest entry or enum value | **major** |
| Change public type non-additively | **major** |
| Change library behavior (cache key algorithm, serialization, breaker defaults) | **major** |
| Bug fix or internal refactor, no behavior change | patch |
| Docs, tests, tooling only | no bump |

When in doubt, pick the higher bump.

### Changelog

Every PR that warrants a bump adds an entry to `CHANGELOG.md` under `[Unreleased]` in the right category (`Added`, `Changed`, `Fixed`, `Removed`, `Security`).

### PR checklist (from `.github/pull_request_template.md`)

- Summary of the change
- Semver bump category selected
- `CHANGELOG.md` entry added
- Manifest changes called out explicitly
- `tsc --noEmit` passes
- All unit tests pass
- Playground scenarios pass

---

## Troubleshooting

### `Valkey: DOWN` in the playground

```bash
# Check if the container is running
docker ps | grep valkey

# Start it if not
npm run dev:up

# Confirm the port is bound
nc -zv localhost 6379
```

### Mock server not responding

```bash
# Is it running?
curl http://localhost:4000/mock/user

# Restart it
# Ctrl-C in Terminal 1, then:
npm run dev:mock
```

### Playground shows stale HITs — expecting a MISS

The cache from a previous run is still in Valkey. Flush it:

```bash
npm run dev:reset    # runs: valkey-cli flushall inside the container
```

### `tsx` not found

```bash
npx tsx scripts/dev.ts    # use npx if tsx isn't globally installed
```

Or install globally:
```bash
npm install -g tsx
```

### Circuit breaker scenario fails (`Expected CircuitOpenError`)

Two common causes:

1. **Wrong route** — if you're using `uri` to vary cache keys, the appended path may not match the mock server handler. Use `queryParams` instead (the path stays `/mock/fail`, query params vary the cache key).

2. **`allowWarmUp: true` in effect** — with the default breaker config, the circuit won't trip until the rolling 10-second window has been filled. The dev playground uses `allowWarmUp: false` on `mock-fail` to work around this. If you're testing a custom manifest entry, add `circuitBreakerOptions: { allowWarmUp: false }` to get fast tripping in dev.

### `esbuild` platform error in Docker

```
Error: You installed esbuild for another platform than the one you're currently using.
```

This happens when `node_modules` is mounted from macOS into a Linux container. The mock server is intentionally run on the host (`npm run dev:mock`) to avoid this. If you see this error from a Docker container, don't run `tsx` inside a container that mounts the host `node_modules`. Use a Dockerfile that runs `npm install` fresh (see `benchmarks/Dockerfile` for the pattern).

### TypeScript errors after pulling

```bash
npm install               # pick up any new dependencies
npm run typecheck         # confirm clean compile
```

### Tests fail after changing `generateCacheKey`

Cache key tests in `service.test.ts` use `vi.stubEnv("GATEWAY_URL", "")` to pin the base URL. If you added a new input to the key (e.g., a new field from the manifest), update both:
- The test expectations (new key hash values)
- The `baseCtx` or `manifest` fixtures if the new field is required

When `generateCacheKey` changes in a way that alters existing key hashes, all keys in Valkey become permanent misses until TTL expires. Note this in the PR.
