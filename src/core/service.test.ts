import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pLimit from "p-limit";
import CircuitBreaker from "opossum";
import { pack } from "msgpackr";
import { ValkeyService } from "./service";
import { ValkeyClient } from "./client";
import {
    Logger,
    RequestContext,
    ServiceManifestConfig,
    CircuitOpenError,
} from "../types/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// `generateCacheKey` is intentionally private on ValkeyService — it is an
// implementation detail of getOrFetch. For Tier 1 unit tests we want to drive
// it directly rather than go through the full getOrFetch path (which would
// require mocking the glide client, p-limit, and opossum). We localize the
// escape hatch here so the test bodies stay readable and strongly typed.
type PrivateSurface = {
    generateCacheKey: (prefix: string, ctx: RequestContext) => string;
};

const reachPrivate = (service: ValkeyService): PrivateSurface =>
    service as unknown as PrivateSurface;

const silentLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const manifest: Record<string, ServiceManifestConfig> = {
    userProfile: {
        method: "GET",
        relativePath: "/profile",
        staticHeaders: {},
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5,
        cacheKeyHeaders: ["x-tenant", "x-a", "x-b"],
    },
    userSearch: {
        method: "POST",
        relativePath: "/search",
        staticHeaders: { "x-static": "pinned" },
        TTLInSeconds: 60,
        apiFetchTimeoutInSeconds: 5,
    },
    userById: {
        method: "GET",
        relativePath: "/users/{userId}/profile",
        staticHeaders: {},
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5,
    },
};

const buildService = (): ValkeyService => {
    // generateCacheKey never touches the client, so a bare cast is safe for
    // this test. If future tests need client behavior, swap in a proper fake.
    const fakeClient = {} as ValkeyClient;
    return new ValkeyService(fakeClient, manifest, silentLogger);
};

const baseCtx: RequestContext = {
    baseUrl: "https://api.example.com",
    uri: "/123",
    method: "GET",
    headers: {},
    body: undefined,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ValkeyService.generateCacheKey", () => {
    let service: ValkeyService;

    beforeEach(() => {
        // Pin GATEWAY_URL to a known value so cache keys are reproducible
        // regardless of the developer's local env.
        vi.stubEnv("GATEWAY_URL", "");
        service = buildService();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    // -- determinism ---------------------------------------------------------

    it("returns the same key for identical inputs", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", baseCtx);
        const b = reachPrivate(service).generateCacheKey("userProfile", baseCtx);
        expect(a).toBe(b);
    });

    it("always starts with the prefix", () => {
        const key = reachPrivate(service).generateCacheKey("userProfile", baseCtx);
        expect(key.startsWith("userProfile:")).toBe(true);
    });

    // -- input sensitivity ---------------------------------------------------

    it("differs when the uri changes", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", { ...baseCtx, uri: "/123" });
        const b = reachPrivate(service).generateCacheKey("userProfile", { ...baseCtx, uri: "/456" });
        expect(a).not.toBe(b);
    });

    it("differs when the prefix changes", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", baseCtx);
        const b = reachPrivate(service).generateCacheKey("userSearch", baseCtx);
        expect(a).not.toBe(b);
    });

    it("differs when a cacheKeyHeader value changes", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            headers: { "x-tenant": "t1" },
        });
        const b = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            headers: { "x-tenant": "t2" },
        });
        expect(a).not.toBe(b);
    });

    // -- header order and casing --------------------------------------------

    it("is independent of header insertion order", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            headers: { "x-a": "1", "x-b": "2" },
        });
        const b = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            headers: { "x-b": "2", "x-a": "1" },
        });
        expect(a).toBe(b);
    });

    // -- headers not in cacheKeyHeaders are ignored -------------------------

    it("ignores headers not in cacheKeyHeaders", () => {
        const without = reachPrivate(service).generateCacheKey("userProfile", baseCtx);
        const with_ = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            headers: { authorization: "Bearer secret", cookie: "sid=abc", "x-forwarded-for": "10.0.0.1" },
        });
        expect(without).toBe(with_);
    });

    // -- request body inclusion ---------------------------------------------

    it("does not include the request body for GET requests", () => {
        const withoutBody = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            method: "GET",
            body: undefined,
        });
        const withBody = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            method: "GET",
            body: { foo: "bar" },
        });
        expect(withoutBody).toBe(withBody);
    });

    it("includes the request body for POST requests", () => {
        const ctxA: RequestContext = { ...baseCtx, method: "POST", body: { foo: "bar" } };
        const ctxB: RequestContext = { ...baseCtx, method: "POST", body: { foo: "baz" } };
        const a = reachPrivate(service).generateCacheKey("userSearch", ctxA);
        const b = reachPrivate(service).generateCacheKey("userSearch", ctxB);
        expect(a).not.toBe(b);
    });

    it("produces the same key for POST bodies with differently-ordered keys", () => {
        // This is the canonical-JSON invariant: {a:1,b:2} and {b:2,a:1} must
        // hash identically, otherwise two logically-equal requests would miss
        // each other's cache entries.
        const ctxA: RequestContext = { ...baseCtx, method: "POST", body: { a: 1, b: 2 } };
        const ctxB: RequestContext = { ...baseCtx, method: "POST", body: { b: 2, a: 1 } };
        const a = reachPrivate(service).generateCacheKey("userSearch", ctxA);
        const b = reachPrivate(service).generateCacheKey("userSearch", ctxB);
        expect(a).toBe(b);
    });

    it("produces the same key for nested POST bodies regardless of nested key order", () => {
        const ctxA: RequestContext = {
            ...baseCtx,
            method: "POST",
            body: { outer: { a: 1, b: 2 }, trailing: true },
        };
        const ctxB: RequestContext = {
            ...baseCtx,
            method: "POST",
            body: { trailing: true, outer: { b: 2, a: 1 } },
        };
        const a = reachPrivate(service).generateCacheKey("userSearch", ctxA);
        const b = reachPrivate(service).generateCacheKey("userSearch", ctxB);
        expect(a).toBe(b);
    });

    // -- path params -----------------------------------------------------------

    it("differs when a path param value changes", () => {
        const a = reachPrivate(service).generateCacheKey("userById", {
            ...baseCtx,
            params: { userId: "u1" },
        });
        const b = reachPrivate(service).generateCacheKey("userById", {
            ...baseCtx,
            params: { userId: "u2" },
        });
        expect(a).not.toBe(b);
    });

    it("produces the same key for the same path param value", () => {
        const a = reachPrivate(service).generateCacheKey("userById", {
            ...baseCtx,
            params: { userId: "u1" },
        });
        const b = reachPrivate(service).generateCacheKey("userById", {
            ...baseCtx,
            params: { userId: "u1" },
        });
        expect(a).toBe(b);
    });

    it("throws UNRESOLVED_PATH_PARAM when a placeholder has no matching param", () => {
        expect(() =>
            reachPrivate(service).generateCacheKey("userById", {
                ...baseCtx,
                // userId not supplied — {userId} stays in the path
            }),
        ).toThrow("UNRESOLVED_PATH_PARAM: {userId}");
    });

    // -- query params ----------------------------------------------------------

    it("differs when queryParams values change", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            uri: undefined,
            queryParams: { page: "1" },
        });
        const b = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            uri: undefined,
            queryParams: { page: "2" },
        });
        expect(a).not.toBe(b);
    });

    it("is independent of queryParams insertion order", () => {
        const a = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            uri: undefined,
            queryParams: { page: "1", size: "20" },
        });
        const b = reachPrivate(service).generateCacheKey("userProfile", {
            ...baseCtx,
            uri: undefined,
            queryParams: { size: "20", page: "1" },
        });
        expect(a).toBe(b);
    });
});

// ---------------------------------------------------------------------------
// Tier 2: Stateful behavior tests (mocked I/O)
// ---------------------------------------------------------------------------

const createFakeGlideClient = () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue("OK"),
    exists: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue("PONG"),
    getStatistics: vi.fn().mockReturnValue({}),
    close: vi.fn().mockResolvedValue(undefined),
});

const createFakeValkeyClient = (glideClient = createFakeGlideClient()) =>
    ({
        connect: vi.fn().mockResolvedValue(glideClient),
        disconnect: vi.fn().mockResolvedValue(undefined),
    }) as unknown as ValkeyClient;

describe("ValkeyService.getOrFetch", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("throws PREFIX_NOT_FOUND for an unknown prefix", async () => {
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        await expect(
            service.getOrFetch("nonExistent", baseCtx),
        ).rejects.toThrow("PREFIX_NOT_FOUND: nonExistent");
    });

    it("deduplicates concurrent calls for the same cache key", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        const responseData = { id: 1, name: "test" };
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(JSON.stringify(responseData), { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);

        // Fire 10 concurrent calls with the exact same prefix + context.
        // Only one should actually hit fetch — the rest return the in-flight promise.
        const results = await Promise.all(
            Array.from({ length: 10 }, () =>
                service.getOrFetch("userProfile", baseCtx),
            ),
        );

        for (const result of results) {
            expect(result.data).toEqual(responseData);
        }

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws 503 when the request queue exceeds MAX_QUEUE_SIZE", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        // Lower thresholds so we don't need 600 requests to fill the queue.
        // We're testing the overload check, not the exact default values.
        (service as any).limit = pLimit(2);
        (service as any).MAX_QUEUE_SIZE = 3;

        // fetch never resolves — holds every limiter slot forever
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() => new Promise(() => {})),
        );

        // Fire 5 requests: 2 active + 3 pending = pendingCount reaches 3
        for (let i = 0; i < 5; i++) {
            service.getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` });
        }

        // Let all 5 progress past cache-miss check and into the limiter
        await new Promise((r) => setTimeout(r, 0));

        // The 6th request should trigger the overload guard
        await expect(
            service.getOrFetch("userProfile", {
                ...baseCtx,
                uri: "/overload",
            }),
        ).rejects.toThrow("HTTP 503 - Service OverLoad");
    });
});

// ---------------------------------------------------------------------------
// Tier 2: Cache HIT / WRITE path
// ---------------------------------------------------------------------------

describe("ValkeyService.getOrFetch — cache behavior", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it("returns unpacked data from cache HIT without calling fetch", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const fakeGlide = createFakeGlideClient();
        const cachedData = { id: 1, name: "from-cache" };

        // Seed the fake glide client with msgpack-packed data
        fakeGlide.get.mockResolvedValue(Buffer.from(pack(cachedData)));

        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            manifest,
            silentLogger,
        );

        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const result = await service.getOrFetch("userProfile", baseCtx);

        expect(result.data).toEqual(cachedData);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("writes msgpack-packed bytes to cache after a fetch", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const fakeGlide = createFakeGlideClient();
        // get returns null → cache MISS
        fakeGlide.get.mockResolvedValue(null);

        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            manifest,
            silentLogger,
        );

        const responseData = { id: 2, name: "from-api" };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify(responseData), { status: 200 }),
            ),
        );

        const result = await service.getOrFetch("userProfile", baseCtx);
        expect(result.data).toEqual(responseData);

        // setToCache is fire-and-forget — wait a tick for it to execute
        await new Promise((r) => setTimeout(r, 0));

        expect(fakeGlide.set).toHaveBeenCalledTimes(1);

        // Verify the written bytes are valid msgpack of the original data
        const [_key, writtenBuffer] = fakeGlide.set.mock.calls[0];
        expect(Buffer.isBuffer(writtenBuffer)).toBe(true);

        const { unpack } = await import("msgpackr");
        expect(unpack(writtenBuffer)).toEqual(responseData);
    });

    it("skips cache READ but still writes when TTL is 0", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const zeroTtlManifest: Record<string, ServiceManifestConfig> = {
            noCache: {
                method: "GET",
                relativePath: "/no-cache",
                staticHeaders: {},
                TTLInSeconds: 0,
                apiFetchTimeoutInSeconds: 5,
            },
        };
        const fakeGlide = createFakeGlideClient();
        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            zeroTtlManifest,
            silentLogger,
        );

        const responseData = { id: 3 };
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify(responseData), { status: 200 }),
            ),
        );

        const result = await service.getOrFetch("noCache", baseCtx);
        expect(result.data).toEqual(responseData);

        await new Promise((r) => setTimeout(r, 0));

        // Cache read is skipped when TTL is 0 (service.ts:303)
        expect(fakeGlide.get).not.toHaveBeenCalled();
        // Cache write still happens — the write guard is `if (isConnected)`,
        // not `if (isConnected && TTL > 0)`. This may be intentional (warmup)
        // or a bug worth reviewing in service.ts:335.
        expect(fakeGlide.set).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Tier 2: Circuit breaker
// ---------------------------------------------------------------------------

describe("ValkeyService.getOrFetch — HTTP status handling", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    const buildServiceWithLowThresholdBreaker = () => {
        const fakeGlide = createFakeGlideClient();
        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            manifest,
            silentLogger,
        );

        // Replace the breaker for "userProfile" with one that trips after just 3 requests.
        // Keeps the same errorFilter so the status-handling behavior is preserved.
        (service as any).breakers.set(
            "userProfile",
            new CircuitBreaker(
                (service as any).performFetch.bind(service),
                {
                    volumeThreshold: 3,
                    errorThresholdPercentage: 50,
                    resetTimeout: 30000,
                    timeout: 10000,
                    errorFilter: (err: any) => err.status && err.status !== 429 && err.status < 500,
                },
            ),
        );

        return service;
    };

    // -- 5xx: throw + breaker counts ------------------------------------------

    it("opens the breaker after enough 5xx failures", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = buildServiceWithLowThresholdBreaker();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
        );

        for (let i = 0; i < 3; i++) {
            await service
                .getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` })
                .catch(() => {});
        }

        await expect(
            service.getOrFetch("userProfile", {
                ...baseCtx,
                uri: "/after-trip",
            }),
        ).rejects.toThrow(CircuitOpenError);
    });

    // -- Other 4xx: return { status, data: null }, breaker ignores ------------

    it("returns data with upstreamStatus for 404 (does not throw)", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
        );

        const result = await service.getOrFetch("userProfile", baseCtx);
        expect(result.data).toBeNull();
        expect(result.upstreamStatus).toBe(404);
    });

    it("does NOT open the breaker for 404 errors", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = buildServiceWithLowThresholdBreaker();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
        );

        // Fire 4 requests — all return 404 but breaker should stay closed
        for (let i = 0; i < 4; i++) {
            await service.getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` });
        }

        // The 5th request should still go through (breaker is NOT open)
        const result = await service.getOrFetch("userProfile", {
            ...baseCtx,
            uri: "/still-works",
        });
        expect(result.data).toBeNull();
        expect(result.upstreamStatus).toBe(404);
    });

    // -- 401/403: throw, breaker does NOT count -------------------------------

    it("throws on 401 Unauthorized", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
        );

        await expect(
            service.getOrFetch("userProfile", baseCtx),
        ).rejects.toThrow("API_AUTH_ERROR - HTTP 401");
    });

    it("throws on 403 Forbidden", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 403 })),
        );

        await expect(
            service.getOrFetch("userProfile", baseCtx),
        ).rejects.toThrow("API_AUTH_ERROR - HTTP 403");
    });

    it("does NOT open the breaker for 401/403 errors", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = buildServiceWithLowThresholdBreaker();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 401 })),
        );

        // Fire 4 requests — all throw 401 but breaker should stay closed
        for (let i = 0; i < 4; i++) {
            await service
                .getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` })
                .catch(() => {});
        }

        // The 5th request still goes through — throws 401, not "Breaker is open"
        await expect(
            service.getOrFetch("userProfile", {
                ...baseCtx,
                uri: "/still-works",
            }),
        ).rejects.toThrow("API_AUTH_ERROR - HTTP 401");
    });

    // -- 429: throw + breaker COUNTS it ---------------------------------------

    it("throws on 429 Too Many Requests", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService(
            createFakeValkeyClient(),
            manifest,
            silentLogger,
        );

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
        );

        await expect(
            service.getOrFetch("userProfile", baseCtx),
        ).rejects.toThrow("API_RATE_LIMITED - HTTP 429");
    });

    it("opens the breaker after enough 429 failures", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = buildServiceWithLowThresholdBreaker();

        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(new Response(null, { status: 429 })),
        );

        for (let i = 0; i < 3; i++) {
            await service
                .getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` })
                .catch(() => {});
        }

        await expect(
            service.getOrFetch("userProfile", {
                ...baseCtx,
                uri: "/after-trip",
            }),
        ).rejects.toThrow(CircuitOpenError);
    });
});

// ---------------------------------------------------------------------------
// Event loop lag
//
// These tests verify that synchronous operations on the hot path —
// SHA-256 key generation, the JSON.stringify key-sorting replacer, and
// msgpackr pack/unpack — do not block the event loop for long enough to
// cause latency spikes in a concurrent server.
//
// Mechanism: while work runs, a monitor loop continuously schedules
// setImmediate probes and measures how long each probe takes to fire.
// A synchronous operation that holds the CPU will delay those probes.
// ---------------------------------------------------------------------------

describe("ValkeyService — event loop lag", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    // Max acceptable lag during any single event loop turn on the hot path.
    const LAG_THRESHOLD_MS = 50;

    // Runs `workFn` while continuously probing the event loop.
    // Returns the maximum observed lag in milliseconds.
    async function measureMaxLag(workFn: () => Promise<void>): Promise<number> {
        let maxLag = 0;
        let stop = false;

        const monitor = (async () => {
            while (!stop) {
                const t = performance.now();
                await new Promise<void>((resolve) => setImmediate(resolve));
                const lag = performance.now() - t;
                if (lag > maxLag) maxLag = lag;
            }
        })();

        await workFn();
        stop = true;
        await monitor;
        return maxLag;
    }

    // Builds a wide flat object (many top-level keys) to stress the
    // key-sorting JSON.stringify replacer in hashRequestBody.
    function buildWideBody(keyCount: number): Record<string, string> {
        return Object.fromEntries(
            Array.from({ length: keyCount }, (_, i) => [`field_${i}`, `value_${i}`]),
        );
    }

    // Builds a deeply nested object to stress the recursive replacer.
    function buildDeepBody(depth: number, branching: number): Record<string, unknown> {
        if (depth === 0) return { v: Math.random().toString(36).slice(2) };
        return Object.fromEntries(
            Array.from({ length: branching }, (_, i) => [
                `k${i}`,
                buildDeepBody(depth - 1, branching),
            ]),
        );
    }

    it("generateCacheKey with a large flat POST body stays under lag threshold", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService({} as ValkeyClient, manifest, silentLogger);

        // 1 000-key flat object — exercises the key-sorting replacer at breadth.
        // Yield after each call so the monitor observes per-call lag, not the
        // cumulative cost of a tight synchronous loop.
        const largeBody = buildWideBody(1000);

        const lag = await measureMaxLag(async () => {
            for (let i = 0; i < 200; i++) {
                reachPrivate(service).generateCacheKey("userSearch", {
                    ...baseCtx,
                    method: "POST",
                    body: largeBody,
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        });

        expect(lag).toBeLessThan(LAG_THRESHOLD_MS);
    });

    it("generateCacheKey with a deeply nested POST body stays under lag threshold", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const service = new ValkeyService({} as ValkeyClient, manifest, silentLogger);

        // depth=4, branching=5 → 156 internal nodes, 625 leaf nodes
        const deepBody = buildDeepBody(4, 5);

        const lag = await measureMaxLag(async () => {
            for (let i = 0; i < 200; i++) {
                reachPrivate(service).generateCacheKey("userSearch", {
                    ...baseCtx,
                    method: "POST",
                    body: deepBody,
                });
                await new Promise<void>((resolve) => setImmediate(resolve));
            }
        });

        expect(lag).toBeLessThan(LAG_THRESHOLD_MS);
    });

    it("cache HITs with a large payload stay under lag threshold (unpack path)", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const largeData = buildWideBody(1000);
        const packed = Buffer.from(pack(largeData));

        const fakeGlide = createFakeGlideClient();
        // Every get returns the packed data → every call is a cache HIT
        fakeGlide.get.mockResolvedValue(packed);

        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            manifest,
            silentLogger,
        );

        const lag = await measureMaxLag(async () => {
            for (let i = 0; i < 200; i++) {
                // Different uri → different cache key → no in-flight dedup
                await service.getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` });
            }
        });

        expect(lag).toBeLessThan(LAG_THRESHOLD_MS);
    });

    it("cache MISSes with a large response stay under lag threshold (pack path)", async () => {
        vi.stubEnv("GATEWAY_URL", "");
        const largeData = buildWideBody(1000);

        const fakeGlide = createFakeGlideClient();
        fakeGlide.get.mockResolvedValue(null); // always MISS

        const service = new ValkeyService(
            createFakeValkeyClient(fakeGlide),
            manifest,
            silentLogger,
        );

        // Create a fresh Response per call — Response bodies can only be read once.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockImplementation(() =>
                Promise.resolve(new Response(JSON.stringify(largeData), { status: 200 })),
            ),
        );

        const lag = await measureMaxLag(async () => {
            for (let i = 0; i < 100; i++) {
                await service.getOrFetch("userProfile", { ...baseCtx, uri: `/${i}` });
            }
        });

        expect(lag).toBeLessThan(LAG_THRESHOLD_MS);
    });
});
