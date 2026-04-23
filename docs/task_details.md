# Method Resource Intensity Analysis

Review of all methods under `src/` categorized by CPU, I/O, and memory intensity.

---

## CPU-Intensive

| Method | File | Reason |
|--------|------|--------|
| `generateCacheKey()` | `src/core/service.ts` | Recursive JSON key sorting + canonicalisation + SHA256 hashing — scales with body depth/size and header count |
| `performFetch()` | `src/core/service.ts` | `JSON.parse()` on raw response bytes — scales with response size |
| `buildUpstreamUrl()` | `src/core/service.ts` | Regex substitution, `encodeURIComponent()`, query param sorting |
| `selectHeadersForCacheKey()` | `src/core/service.ts` | Double linear scan + case normalization of headers |

---

## I/O-Intensive

| Method | File | Reason |
|--------|------|--------|
| `initializeValkeyConnection()` | `src/core/client.ts` | Opens TLS/TCP connection to Valkey server — network latency bound |
| `getClient()` / `connect()` | `src/core/client.ts` | First call blocks on connection establishment |
| `disconnect()` | `src/core/client.ts` | Closes connection pool — network teardown |
| `getFromCache()` | `src/core/service.ts` | `client.get()` — network round-trip to Valkey |
| `setToCache()` | `src/core/service.ts` | `client.set()` with TTL — network write to Valkey |
| `health()` | `src/core/service.ts` | `client.ping()` — network round-trip |
| `keyExists()` | `src/core/service.ts` | `client.exists()` — network operation per key |
| `getStats()` | `src/core/service.ts` | `client.getStatistics()` — connection pool query |
| `performFetch()` | `src/core/service.ts` | Outbound HTTP fetch + `response.bytes()` — network bound |
| `getOrFetch()` | `src/core/service.ts` | Orchestrates cache read → upstream fetch → cache write (all I/O) |
| `init()` | `src/index.ts` | Triggers async Valkey connection warmup |

---

## Memory-Intensive

| Method | File | Reason |
|--------|------|--------|
| `performFetch()` | `src/core/service.ts` | `response.bytes()` buffers entire response as `Uint8Array` + `Buffer.from()` — scales with response size |
| `getOrFetch()` | `src/core/service.ts` | `JSON.parse()` builds full object graph + `pack()` msgpack serialization + `requestsInFlight` Map (up to 500 in-flight promises) |
| `getFromCache()` | `src/core/service.ts` | Returns raw `Buffer` from Valkey — scales with cached value size |
| `setToCache()` | `src/core/service.ts` | Holds packed `Buffer` for write — scales with data size |
| Circuit breaker state (`breakers` Map) | `src/core/service.ts` | One `CircuitBreaker` instance per `serviceName`, shared across all manifest entries targeting the same upstream — each maintains request history |

---

## Low / Negligible Resource

| Method | File | Reason |
|--------|------|--------|
| `calculateTimeElapsed()` | `src/core/service.ts` | Simple arithmetic |
| `hasRequestBody()` | `src/core/service.ts` | Array/key length check |
| `validateAndLoadConfig()` | `src/core/client.ts` | Env var reads + Zod validation, one-time |
| `errorHandler()` | `src/core/client.ts` | Type check + string formatting |
| `requireService()` | `src/index.ts` | Guard check, no-op if initialized |

---

## Key Observations

- **`getOrFetch()`** is the hottest method — it chains I/O (cache read), CPU (hash + JSON parse), and memory (buffer + msgpack + in-flight Map). It's the critical path.
- **`performFetch()`** is CPU + memory + I/O together — the entire response is buffered in memory before parsing.
- **`generateCacheKey()`** is the most purely CPU-bound operation — a deeply nested request body with many keys will cause noticeable latency in the inline key-sorting stringify.
- The `requestsInFlight` Map caps at `MAX_QUEUE_SIZE = 500`, so memory pressure from deduplication is bounded.


| Component | Data Size | V8 Object Overhead | Total (Approx) |
| :--- | :--- | :--- | :--- |
| **SHA-256 Key** | 64 chars | +16 (Header) + Alignment | **~80 bytes** |
| **Map Entry** | 24 (Pointers) | Hash Table Sparsity / Buckets | **~100 bytes** |
| **Promise Ref** | 8 bytes | None (it's a raw pointer) | **8 bytes** |
| **Padding/Slack** | - | 8-byte word alignment rounding | **~46 bytes** |
| **Total** | | | **~234 bytes** |
