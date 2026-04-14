# ValkeyService

`src/core/service.ts`

The main cache-aside engine of the library. It sits between consuming apps and the origin API, using Valkey as a transparent read-through cache. Consuming apps call `getOrFetch()` with a service manifest prefix and request context — the service handles cache lookup, origin fetch, serialization, concurrency control, and circuit breaking.

## Responsibilities

1. **Cache key generation** — Builds a deterministic, collision-resistant SHA-256 cache key from the manifest prefix, HTTP method, full URL, and an optional hashed request body. Only headers explicitly listed in `cacheKeyHeaders` on the manifest entry are included — any header not in that list is ignored, making the key stable against proxy-injected or auth headers.

2. **In-flight request deduplication** — Concurrent calls for the same cache key share a single Promise via a `Map<string, Promise>`. This prevents stampede scenarios where N callers all miss the cache and fire N identical origin fetches.

3. **Concurrency limiting** — Uses `p-limit` to cap parallel origin fetches at 100. When the pending queue exceeds `MAX_QUEUE_SIZE` (500), the service short-circuits with a 503 error. A warning is logged at 80% capacity.

4. **Circuit breaking** — Wraps origin fetches in an `opossum` circuit breaker. Only 429 (rate limited) and 5xx (server errors) count toward the failure threshold. Auth errors (401/403), client closed (499), and other 4xx are filtered out. The circuit opens at 50% error rate and resets after 30 seconds.

5. **Serialization** — Cache entries are stored as msgpack (`msgpackr`) instead of raw JSON. This is more compact on disk/memory in Valkey and faster to deserialize on cache hits (`unpack` vs `JSON.parse`).

6. **Graceful degradation** — When Valkey is down, the service falls through to the origin fetch transparently. Cache writes that fail are caught and logged, never thrown to callers.

## Architecture

```
getOrFetch(prefix, ctx)
      |
      v
  check requestsInFlight map
      |
      +--[duplicate]---> return existing Promise (dedup)
      |
      +--[new]--> generate cache key
                      |
                      v
                connect to Valkey
                      |
                +--[connected + TTL > 0]--> getFromCache()
                |                               |
                |                        [HIT] --> unpack(msgpack), return
                |                               |
                |                        [MISS] --> continue to origin fetch
                |
                +--[disconnected or TTL = 0]--> skip cache read
                      |
                      v
                check p-limit queue depth
                      |
                +--[>= MAX_QUEUE_SIZE]--> throw 503
                      |
                +--[ok]--> limit(() => breaker.fire(performFetch))
                                |
                                v
                          origin API fetch (performFetch)
                                |
                         [2xx]-------> JSON.parse response
                                |        |
                                |   [connected]--> pack(msgpack), setToCache (fire-and-forget)
                                |        |
                                |        v
                                |     return { data, upstreamStatus }
                                |
                         [other 4xx]--> return { data: null, upstreamStatus }
                                |       (consumer decides what 404 etc. means)
                                |
                         [401/403]----> throw (auth failure, consumer must handle)
                         [429]--------> throw (rate limited, breaker COUNTS it)
                         [499]--------> throw (client closed, breaker ignores)
                         [5xx]--------> throw (server error, breaker COUNTS it)
```

## URL building

Before a cache key is generated or an origin fetch is fired, `buildUpstreamUrl` resolves the full URL from three sources in order:

1. **Base** — `GATEWAY_URL` env var, falling back to `ctx.baseUrl`. Trailing slashes are stripped.
2. **Path params** — `{param}` placeholders in `relativePath` are replaced by `ctx.params` values (URI-encoded). If any placeholder is left unresolved — whether because `params` was omitted or a key is missing — the method throws `UNRESOLVED_PATH_PARAM`.
3. **Legacy suffix** — `ctx.uri` is appended as-is (backward compatible with the old free-form suffix pattern).
4. **Query string** — `ctx.queryParams` entries are sorted alphabetically and appended as `?k=v&...` (both keys and values URI-encoded). Sorting ensures `{a:"1", b:"2"}` and `{b:"2", a:"1"}` produce identical URLs and therefore identical cache keys.

Both `generateCacheKey` and `performFetch` call `buildUpstreamUrl`, so the URL used for the cache key always matches the URL used for the actual fetch.

```ts
// Path param example
await service.getOrFetch("getUserById", {
    baseUrl: "https://api.example.com",
    params: { userId: "u123" },         // replaces {userId} in relativePath
    queryParams: { fields: "name,email" },
});

// relativePath "/users/{userId}/profile" → "/users/u123/profile?fields=name%2Cemail"
```

## Cache key anatomy

The cache key is built from multiple request attributes to ensure uniqueness:

```
{prefix}:{sha256_hex}
```

Where the SHA-256 input is:

```
{prefix}:{method}:{resolvedUrl}|headers:{sorted_header_pairs}|requestBody:{body_sha256}
```

Where `resolvedUrl` is the output of `buildUpstreamUrl` — base + path-param-resolved relativePath + optional uri + sorted query string.

### Header selection (`cacheKeyHeaders`)

By default, no request headers are included in the cache key. Only headers explicitly listed in the manifest entry's `cacheKeyHeaders` field are used. This is an allow-list: any header absent from the list — including auth headers, cookies, and proxy-injected headers like `x-forwarded-for` — is silently ignored.

This prevents a common failure mode where a proxy or load balancer injects a new header, unexpectedly making every request generate a unique cache key and dropping hit rates to zero.

To vary cache entries by a header, declare it in the manifest:

```ts
[ServiceManifest.AUTH_PROFILE_V2]: {
    method: "GET",
    relativePath: "/v1/auth-profile",
    staticHeaders: { apikey: API_KEY },
    TTLInSeconds: 300,
    apiFetchTimeoutInSeconds: 5,
    cacheKeyHeaders: ["x-tenant"],   // cache is keyed per tenant
},
```

If `cacheKeyHeaders` is omitted or empty, the key is based solely on the prefix, method, and URL.

### Header ordering

Headers are sorted alphabetically before hashing. This means `{a: "1", b: "2"}` and `{b: "2", a: "1"}` produce the same cache key.

### Request body handling

- GET requests never include the body in the key (even if one is present).
- For other methods, the body is JSON-serialized with sorted keys at every nesting level (`JSON.stringify` with a replacer), then SHA-256 hashed. This ensures `{a:1, b:2}` and `{b:2, a:1}` produce identical keys.
- Null, undefined, empty objects, and empty arrays are treated as "no body".

## Services manifest

Each service is registered in `src/config/manifest.ts` using the `ServiceManifest` enum as the key. The manifest entry defines everything needed to fetch from the origin and cache the response:

| Field | Type | Description |
|---|---|---|
| `method` | `HttpMethod` | HTTP method for the origin fetch |
| `relativePath` | `string` | Path appended to the base URL. Supports `{param}` placeholders resolved at call time from `ctx.params` |
| `staticHeaders` | `Record<string, any>` | Headers merged with request-time headers (static wins on conflict — request headers are spread first, then static) |
| `TTLInSeconds` | `number` | Cache TTL. When `0`, cache reads are skipped but writes still occur |
| `apiFetchTimeoutInSeconds` | `number` | Per-request timeout for the origin fetch (`AbortSignal.timeout`) |
| `cacheKeyHeaders` | `string[]` | Optional allow-list of request headers included in the cache key. Only headers named here differentiate cache entries — all others are ignored. Omit when no header varies the response |
| `metadata` | `Record<string, string>` | Optional metadata (not used in fetch or caching logic) |

## Public API

### `getOrFetch<T>(prefix: string, ctx: RequestContext): Promise<FetchResult<T>>`

The primary method. Looks up the cache, falls through to origin on miss, writes back to cache. Returns `{ data, upstreamStatus? }` — see the HTTP status handling table below for what gets returned vs thrown. Throws `PREFIX_NOT_FOUND` if the prefix isn't in the manifest. Throws `HTTP 503` if the concurrency queue is full.

### `getFromCache(cacheKey: string): Promise<CacheReadResult<Buffer> | null>`

Direct cache read. Returns a result with `status` of `HIT`, `MISS`, `DOWN`, or `ERROR`.

### `setToCache(cacheKey: string, data: Buffer, ttlInSeconds?: number): Promise<CacheWriteResult | null>`

Direct cache write. Uses `onlyIfDoesNotExist` conditional set — never overwrites an existing key. Falls back to `DEFAULT_TTL_IN_SECONDS` (300s) when no TTL is provided.

### `health(): Promise<HealthCheckResult>`

Pings Valkey and returns `UP`, `DOWN`, or `ERROR`.

### `keyExists(cacheKey: string[]): Promise<KeyExistsResult>`

Checks if one or more keys exist. Returns the count of existing keys.

### `getStats(): Promise<ValkeyStats>`

Returns glide client statistics (connection pool info, command counts, etc.).

## HTTP status handling

How `performFetch` handles each upstream response status:

| Status | Example | What happens | Thrown to caller? | Breaker counts it? | Cached? | Rationale |
|---|---|---|---|---|---|---|
| 2xx | 200, 201 | Return data | No | No (success) | Yes (200 only) | Happy path |
| 401 | Unauthorized | Throw | Yes | No | No | Caller's token is bad — not upstream's fault |
| 403 | Forbidden | Throw | Yes | No | No | Caller lacks permissions — not upstream's fault |
| 429 | Too Many Requests | Throw | Yes | **Yes** | No | Upstream is rate-limiting — breaker should open to give it breathing room |
| Other 4xx | 400, 404, 409, 422 | Return `{ data: null, upstreamStatus }` | No | No | No | Client error — consumer checks `upstreamStatus` and decides |
| 499 | Client Closed | Throw | Yes | No | No | Caller hung up — upstream is fine, nothing to return |
| 5xx | 500, 502, 503 | Throw | Yes | **Yes** | No | Upstream broken — breaker protects it |

## Circuit breaker configuration

Each manifest entry gets its own independent circuit breaker, created lazily on first use via `getBreakerFor(prefix)`. A failing endpoint only trips its own breaker — other endpoints are unaffected.

All breakers share the same configuration:

| Setting | Value | Rationale |
|---|---|---|
| `allowWarmUp` | `true` | Don't open the circuit on the first few errors during startup |
| `volumeThreshold` | `100` | Minimum requests before the error percentage is evaluated |
| `timeout` | `10000ms` | Individual request timeout within the breaker |
| `errorThresholdPercentage` | `50%` | Circuit opens when half of requests fail |
| `resetTimeout` | `30000ms` | Half-open probe interval after the circuit opens |
| `errorFilter` | `status !== 429 && status < 500` | Only 429 and 5xx count as breaker failures. 401, 403, 499 are thrown but filtered — not the upstream's fault |

### `CircuitOpenError`

When a breaker is open and rejects a request, the service throws a `CircuitOpenError` instead of opossum's raw internal error. This gives consumers a stable, typed error to catch:

```ts
import { CircuitOpenError } from "valkey-cache";

try {
    await ValkeyCacheWrapper.getWithFetch(ServiceManifest.AUTH_PROFILE_V2, ctx);
} catch (err) {
    if (err instanceof CircuitOpenError) {
        // err.prefix  — which endpoint is down
        // err.status  — always 503
    }
}
```

### Breaker events

Each breaker emits log entries on state transitions via `registerBreakerEvents`:

| Event | Log level | Message |
|---|---|---|
| `open` | `error` | `CIRCUIT_OPEN: {prefix} — error threshold exceeded, requests suspended` |
| `halfOpen` | `warn` | `CIRCUIT_HALF_OPEN: {prefix} — probing upstream` |
| `close` | `info` | `CIRCUIT_CLOSED: {prefix} — upstream recovered` |
| `timeout` | `warn` | `CIRCUIT_TIMEOUT: {prefix} — request timed out` |
| `reject` | `warn` | `CIRCUIT_REJECT: {prefix} — request rejected, circuit is open` |

## Concurrency limits

| Setting | Value |
|---|---|
| `pLimit` concurrency | `100` parallel origin fetches |
| `MAX_QUEUE_SIZE` | `500` pending requests before 503 |
| Warning threshold | `400` (80% of `MAX_QUEUE_SIZE`) |

## Known behaviors

### Cache writes are fire-and-forget

`setToCache` is called without `await` in `getOrFetch`. Failures are caught and logged but never propagated to the caller. This keeps the hot path fast — the caller gets their data immediately after the origin fetch, and the cache write completes in the background.

### TTL=0 skips reads but not writes

When a manifest entry has `TTLInSeconds: 0`, the cache read is skipped (line 302 — gated by `manifest.TTLInSeconds > 0`), but the cache write still executes (line 335 — gated only by `isConnected`). This means data is written to Valkey with the default TTL even when reads are disabled. This is an intentional asymmetry — it pre-warms the cache so that toggling the TTL back to a positive value immediately starts serving hits.

### `onlyIfDoesNotExist` write semantics

`setToCache` uses Valkey's `NX` flag (`conditionalSet: "onlyIfDoesNotExist"`). If a key already exists (e.g., written by a concurrent request that won the dedup race on a different pod), the write is silently skipped. This prevents mid-TTL overwrites and ensures the first writer wins.
