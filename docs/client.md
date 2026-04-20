# ValkeyClient

`src/core/client.ts`

A lazy, singleton-style wrapper around `@valkey/valkey-glide`'s `GlideClusterClient` (cluster mode) or `GlideClient` (standalone mode). It handles config validation, connection lifecycle, and error recovery so that the rest of the library never touches glide directly.

## Responsibilities

1. **Config validation** - Reads connection parameters from environment variables at construction time and validates them through a Zod schema (`AuthConfigSchema`). If validation fails at construction, the client stores `config = null` and retries validation on every subsequent `connect()` call — so if env vars appear later (e.g., dotenv loaded late, secrets injected), the client self-heals without requiring a restart.

2. **Lazy connection** - The actual TCP/TLS connection to Valkey is deferred until the first `connect()` call. This lets consuming apps import and construct the client at module load time without blocking on network I/O.

3. **Connection deduplication** - If multiple callers invoke `connect()` concurrently (common during app startup when several `getOrFetch` calls land at the same time), they all share a single in-flight `createClient` promise. Only one connection is ever opened.

4. **Graceful degradation** - When Valkey is unreachable or misconfigured, `connect()` throws `ValkeyConnectionError` or `ValkeyConfigError`. Callers (primarily `ValkeyService`) catch these errors to fall back to origin fetches without the cache layer.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VALKEY_HOST` | Yes | `""` | Hostname of the Valkey endpoint |
| `VALKEY_PORT` | Yes | `""` | Port number (coerced from string to int by Zod) |
| `VALKEY_USE_TLS` | No | `"true"` | Set to `"false"` to disable TLS |
| `VALKEY_CLUSTER_MODE` | No | `"true"` | Set to `"false"` to connect in standalone mode (uses `GlideClient` instead of `GlideClusterClient`) |
| `VALKEY_USERNAME` | No | - | Credentials for authenticated clusters |
| `VALKEY_PASSWORD` | No | - | Credentials for authenticated clusters |
| `NODE_APP_INSTANCE` | No | `"development"` | When `"development"` or `"local"`, TLS certificate verification is disabled (`tlsInsecure: true`) |

## Lifecycle

```
  new ValkeyClient(logger)
        |
        v
  validateAndLoadConfig()
        |
        +--[invalid]--> config = null  (will retry on next connect())
        |
        +--[valid]----> config stored, ready for lazy connect
                              |
                              v
                        connect() called
                              |
                              +--[config null]----> re-validate env vars
                              |                        |
                              |                 [still invalid] --> return null
                              |                        |
                              |                 [now valid] --> config stored, continue ↓
                              |
                              +--[first call]-----> GlideClusterClient.createClient(config)  [cluster mode]
                              |                    GlideClient.createClient(config)         [standalone mode]
                              |                          |
                              |                   [success] --> client cached, returned
                              |                          |
                              |                   [failure] --> null cached, returned
                              |
                              +--[subsequent]-----> return cached client (or cached null)
                              |
                              v
                        disconnect()
                              |
                              v
                        client.close(), state reset
                        (next connect() starts fresh)
```

## Public API

### `constructor(logger: Logger)`

Validates environment variables immediately. Logs `VALKEY_CONFIG_VALIDATED` on success or an error on failure. Does **not** open a connection.

### `connect(): Promise<GlideClient | GlideClusterClient>`

Returns a connected glide client. Throws `ValkeyConfigError` if env vars are invalid, or `ValkeyConnectionError` if the connection fails. Safe to call repeatedly — the first call creates the connection, subsequent calls return the cached instance.

### `disconnect(): Promise<void>`

Closes the underlying glide connection and resets internal state. After disconnect, the next `connect()` call will create a fresh connection. Idempotent - calling it when not connected is a no-op.

## Glide configuration

The client configures the glide connection with the following settings:

| Setting | Value | Rationale |
|---|---|---|
| `lazyConnect` | `true` | Defers the TCP handshake to first command |
| `connectionTimeout` | `5000ms` | Fail fast on unreachable hosts |
| `requestTimeout` | `5000ms` | Bound individual command latency |
| `inflightRequestsLimit` | `700` | Backpressure before the client starts rejecting |
| `connectionBackoff` | 5 retries, exponential (base 2, factor 1000ms, 20% jitter) | Automatic reconnect on transient failures |
| `credentials` | Included only when both `VALKEY_USERNAME` and `VALKEY_PASSWORD` are set | Supports both authenticated and open clusters |
| `tlsInsecure` | `true` in dev/local, `false` otherwise | Allows self-signed certs in non-production environments |
| Client type | `GlideClusterClient` when `VALKEY_CLUSTER_MODE=true` (default); `GlideClient` when `false` | Both modes set `lazyConnect` from config |

## Known behavior: self-healing config validation

If environment variables are missing or invalid at construction time, `config` is set to `null` rather than entering a permanent error state. On every subsequent `connect()` call, `getClient()` checks whether `config` is null and re-runs `validateAndLoadConfig()`. If the env vars have since become available (e.g., dotenv loaded late, Kubernetes secret injected), the client picks them up and connects normally — no restart required.

See the test `"self-heals when env vars become available after construction"` in `client.test.ts` for documentation of this behavior.

## Known behavior: auto-retry on connection failure

When `GlideClusterClient.createClient` fails, `initializeValkeyConnection` catches the error, clears `clientPromise`, and re-throws as `ValkeyConnectionError`. `getClient()` also clears `clientPromise` before re-throwing, so the next `connect()` call creates a fresh connection attempt automatically — no `disconnect()` required.

Retry storms are not a concern here because glide's `connectionBackoff` config (5 retries, exponential backoff, 20% jitter) already throttles retries within a single `createClient` call. The auto-retry only controls whether the *next external* `connect()` tries again or gives up permanently.

See the test `"auto-retries on next connect() after a connection failure"` in `client.test.ts` for documentation of this behavior.
