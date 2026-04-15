# ValkeyCacheWrapper

`src/index.ts`

The public entry point of the library. Exposes a singleton object — `ValkeyCacheWrapper` — that consuming apps import and use as a one-liner cache layer. The wrapper hides all connection management, service construction, and manifest wiring behind four methods: `init`, `getWithFetch`, `health`, and `close`.

## Design goal

Mimic the simplicity of an nginx location directive call. A consuming app should never deal with Valkey connections, serialization, circuit breakers, or concurrency limits directly. One `init()` at startup, one `getWithFetch()` per request, one `close()` at shutdown.

## Singleton lifecycle

```
import → module loads, no side effects
     |
     v
  init(logger)
     |
     +--[first call]---> captures logger
     |                    creates ValkeyClient + ValkeyService
     |                    fires client.connect() (non-blocking warmup)
     |                    caches initPromise
     |                    returns Promise<ValkeyService>
     |
     +--[subsequent]---> returns cached initPromise (same instance)
     |
     v
  getWithFetch / health / getConnectionStats
     |
     +--[init called]----> delegates to ValkeyService
     |
     +--[init NOT called]--> throws VALKEY_NOT_INITIALIZED
     |
     v
  close()
     |
     v
  nulls all refs (client, service, initPromise, logger)
  awaits client.disconnect()
  (next init() starts fresh)
```

## Module exports

```typescript
// Singleton wrapper
export const ValkeyCacheWrapper;

// Re-exports for consumer convenience
export * from "./types/types";
```

Consumers get everything they need from a single import:

```typescript
import { ValkeyCacheWrapper, ServiceManifest } from "@valkey/cache";
```

## Public API

### `init(logger: Logger): Promise<ValkeyService>`

Must be called once at app startup before any other method. Captures the logger for the lifetime of the singleton and kicks off a non-blocking Valkey connection warmup.

- The returned promise resolves to the `ValkeyService` instance (useful for health checks at startup).
- Connection failures during warmup are logged but do **not** reject the promise — `getWithFetch` can still degrade to origin fetches.
- Calling `init` again returns the same cached promise. The logger from the first call wins.

### `getWithFetch<T>(service: ServiceManifest, ctx: RequestContext): Promise<T | null>`

The primary cache-aside method. Looks up the manifest entry for the given `ServiceManifest` enum value, checks the cache, falls through to the origin API on miss, and writes back to cache.

```typescript
const profile = await ValkeyCacheWrapper.getWithFetch<UserProfile>(
    ServiceManifest.USER_PROFILE_BY_LOGIN_ID,
    {
        baseUrl: process.env.GATEWAY_URL,
        uri: `/12345`,
        headers: { apikey: process.env.MS_API_KEY, "x-request-id": reqId },
    },
);
```

Throws `VALKEY_NOT_INITIALIZED` if called before `init()`.

### `health(): Promise<HealthCheckResult>`

Pings Valkey and returns `{ status: "UP" | "DOWN" | "ERROR", data, timeElapsed, error }`. Use this in your `/health` or readiness probe endpoint.

Throws `VALKEY_NOT_INITIALIZED` if called before `init()`.

### `getConnectionStats(): Promise<ValkeyStats>`

Returns glide client statistics (connection pool info, command counts). Useful for dashboards and debugging.

Throws `VALKEY_NOT_INITIALIZED` if called before `init()`.

### `close(): Promise<void>`

Shuts down the Valkey connection and resets all singleton state. After `close()`, methods throw `VALKEY_NOT_INITIALIZED` until `init()` is called again.

**Shutdown ordering**: References are nulled *before* the async disconnect to prevent new callers from using a closing connection. The `closing` pattern ensures the disconnect completes even after refs are cleared:

```typescript
const closing = client;
client = null;
service = null;
initPromise = null;
capturedLogger = null;
await closing.disconnect();
```

Idempotent — calling `close()` when already closed is a no-op.

## Usage pattern

```typescript
import { ValkeyCacheWrapper, ServiceManifest } from "@valkey/cache";
import { logger } from "./logger";

// Startup
await ValkeyCacheWrapper.init(logger);

// Request handler
app.get("/profile/:id", async (req, res) => {
    const data = await ValkeyCacheWrapper.getWithFetch<Profile>(
        ServiceManifest.USER_PROFILE_BY_LOGIN_ID,
        {
            baseUrl: process.env.GATEWAY_URL,
            uri: `/${req.params.id}`,
            headers: { apikey: process.env.MS_API_KEY, "x-request-id": req.id },
        },
    );
    res.json(data);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
    await ValkeyCacheWrapper.close();
    process.exit(0);
});
```

## Error behavior

| Scenario | Behavior |
|---|---|
| `init()` not called | All methods throw `VALKEY_NOT_INITIALIZED` |
| Valkey down at startup | `init()` resolves (does not reject); `getWithFetch` falls through to origin |
| Valkey down at request time | Cache read returns `DOWN`; origin fetch proceeds normally |
| Origin API 5xx | Circuit breaker counts the error; throws to caller |
| Origin API 4xx | Circuit breaker filters it (does not count); throws to caller |
| Concurrency queue full | `getWithFetch` throws `HTTP 503 - Service OverLoad` |
| `close()` then method call | Throws `VALKEY_NOT_INITIALIZED` |
| `close()` then `init()` | Fresh singleton created, works normally |

## Why a singleton?

Each consuming app should maintain exactly one Valkey connection pool. Here's why that matters:

**Valkey connections are expensive resources.** Each connection holds open a TCP socket (and a TLS session if TLS is enabled). The glide client internally maintains a pool of these connections to multiplex commands across them. Creating a second pool means double the sockets, double the TLS handshakes, and double the memory — all pointing at the same cluster, doing the same work.

**Multiple pools break in-flight deduplication.** The service deduplicates concurrent requests using a `Map` keyed by cache key. If two parts of your app each create their own `ValkeyService`, each has its own `Map`, so identical requests coming from different modules would fire separate origin fetches instead of sharing one.

**Multiple pools break circuit breaker state.** The circuit breaker tracks error rates to decide when to stop sending traffic to a failing origin. If each pool has its own breaker, they each see a fraction of the total traffic — the error threshold takes longer to trigger, and one breaker opening doesn't protect the others from continuing to hammer a down service.

**Multiple pools complicate shutdown.** On `SIGTERM`, you need to drain and close every connection cleanly. With a singleton, `close()` handles it in one call. With multiple instances, you'd need to track and close each one — and miss one means leaked connections and a delayed shutdown.

The singleton pattern enforces all of this at the module level — there's no way to accidentally create multiple connections. The trade-off (global mutable state) is acceptable here because:

1. The connection pool is inherently process-scoped.
2. The lifecycle is explicit (`init` / `close`), not implicit.
3. Tests can reset state via `close()` between test cases.
