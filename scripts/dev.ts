// =============================================================================
// scripts/dev.ts — Local dev playground.
//
// Constructs ValkeyClient + ValkeyService directly (bypasses the singleton)
// so you can test any manifest config without touching the public API.
//
// To add a scenario for your change:
//   1. Add an entry to testManifest pointing at one of the mock server routes.
//   2. Call `await scenario("Your label", async () => { ... })` at the bottom.
//
// Usage:
//   npm run dev          — start containers + run once
//   npm run dev:watch    — restart on file save
//   npm run dev:reset    — flush Valkey (wipe all cached keys)
// =============================================================================

import { ValkeyClient } from "../src/core/client";
import { ValkeyService } from "../src/core/service";
import { CircuitOpenError } from "../src/types/types";
import type { Logger, ServiceManifestConfig, RequestContext } from "../src/types/types";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger: Logger = {
    info:  (msg, ...args) => console.log (`  [INFO]  ${msg}`, ...args),
    warn:  (msg, ...args) => console.warn(`  [WARN]  ${msg}`, ...args),
    error: (msg, ...args) => console.error(`  [ERROR] ${msg}`, ...args),
    debug: (msg, ...args) => console.log (`  [DEBUG] ${msg}`, ...args),
};

// ---------------------------------------------------------------------------
// Test manifest — add entries here when you need a new route to test against.
// Each entry maps a prefix → mock server route + cache config.
// ---------------------------------------------------------------------------

const BASE = "http://localhost:4000";

const testManifest: Record<string, ServiceManifestConfig> = {
    "mock-user": {
        serviceName: "mock-happy-svc",
        method: "GET",
        relativePath: "/mock/user",
        TTLInSeconds: 30,
        apiFetchTimeoutInSeconds: 5,
        cacheKeyHeaders: ["x-tenant"],
    },
    "mock-search": {
        serviceName: "mock-happy-svc",  // same service as mock-user → shares one circuit breaker
        method: "POST",
        relativePath: "/mock/search",
        TTLInSeconds: 30,
        apiFetchTimeoutInSeconds: 5,
    },
    "mock-slow": {
        serviceName: "mock-slow-svc",
        method: "GET",
        relativePath: "/mock/slow",
        TTLInSeconds: 30,
        apiFetchTimeoutInSeconds: 10,
    },
    "mock-fail": {
        serviceName: "mock-fail-svc",   // isolated breaker — won't affect mock-user/mock-search
        method: "GET",
        relativePath: "/mock/fail",
        TTLInSeconds: 30,
        apiFetchTimeoutInSeconds: 5,
        // Low thresholds for fast local testing — production services use the defaults.
        circuitBreakerOptions: { volumeThreshold: 10, allowWarmUp: false },
    },
};

// ---------------------------------------------------------------------------
// Scenario runner — prints PASS/FAIL and keeps going even if one blows up
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

async function scenario(label: string, fn: () => Promise<void>): Promise<void> {
    process.stdout.write(`\n[ ] ${label} ...`);
    try {
        await fn();
        process.stdout.write(`\r[✓] ${label}\n`);
        passed++;
    } catch (err: any) {
        process.stdout.write(`\r[✗] ${label}\n`);
        console.error(`    ${err?.message ?? err}`);
        failed++;
    }
}

function assert(condition: boolean, message: string): void {
    if (!condition) throw new Error(`Assertion failed: ${message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
    console.log("\n=== Valkey Dev Playground ===");

    const client  = new ValkeyClient(logger);
    const service = new ValkeyService(client, testManifest, logger);

    // Verify Valkey is reachable before running scenarios
    const health = await service.health();
    assert(health.status === "UP", `Valkey not reachable — is the container running? (run: npm run dev:up)\nStatus: ${health.status} ${health.error ?? ""}`);
    console.log(`\nValkey: ${health.status} (${health.timeElapsed}s)`);

    // -----------------------------------------------------------------------
    // Scenario 1: Cache miss → hit
    // -----------------------------------------------------------------------
    await scenario("Cache miss then hit", async () => {
        const ctx: RequestContext = { baseUrl: BASE };

        const r1 = await service.getOrFetch("mock-user", ctx);
        assert(r1.upstreamStatus === 200, `Expected upstream 200, got ${r1.upstreamStatus}`);
        assert(r1.data !== null, "Expected data on miss");

        // Small delay to let the async cache write settle
        await new Promise(r => setTimeout(r, 50));

        const r2 = await service.getOrFetch("mock-user", ctx);
        assert(r2.upstreamStatus === undefined, `Expected cache HIT (no upstreamStatus), got ${r2.upstreamStatus}`);
    });

    // -----------------------------------------------------------------------
    // Scenario 2: Different header values → different cache keys
    // -----------------------------------------------------------------------
    await scenario("Header-based cache key isolation", async () => {
        const ctxA: RequestContext = { baseUrl: BASE, headers: { "x-tenant": "tenant-A" } };
        const ctxB: RequestContext = { baseUrl: BASE, headers: { "x-tenant": "tenant-B" } };

        const r1 = await service.getOrFetch("mock-user", ctxA);
        assert(r1.upstreamStatus === 200, "tenant-A: expected upstream fetch");

        await new Promise(r => setTimeout(r, 50));

        const r2 = await service.getOrFetch("mock-user", ctxB);
        assert(r2.upstreamStatus === 200, "tenant-B should miss cache (different key)");

        const r3 = await service.getOrFetch("mock-user", ctxA);
        assert(r3.upstreamStatus === undefined, "tenant-A second request should be a HIT");
    });

    // -----------------------------------------------------------------------
    // Scenario 3: POST body ordering doesn't affect the cache key
    // -----------------------------------------------------------------------
    await scenario("POST body canonicalization (key order shouldn't matter)", async () => {
        const ctxA: RequestContext = { baseUrl: BASE, method: "POST", body: { a: 1, b: 2 } };
        const ctxB: RequestContext = { baseUrl: BASE, method: "POST", body: { b: 2, a: 1 } };

        const r1 = await service.getOrFetch("mock-search", ctxA);
        assert(r1.upstreamStatus === 200, "First POST: expected upstream fetch");

        await new Promise(r => setTimeout(r, 50));

        const r2 = await service.getOrFetch("mock-search", ctxB);
        assert(r2.upstreamStatus === undefined, "Reordered body should hit the same cache entry");
    });

    // -----------------------------------------------------------------------
    // Scenario 4: Different POST bodies → different cache keys
    // -----------------------------------------------------------------------
    await scenario("Different POST bodies → different cache entries", async () => {
        const ctxA: RequestContext = { baseUrl: BASE, method: "POST", body: { query: "cats" } };
        const ctxB: RequestContext = { baseUrl: BASE, method: "POST", body: { query: "dogs" } };

        const r1 = await service.getOrFetch("mock-search", ctxA);
        assert(r1.upstreamStatus === 200, `cats: expected upstream fetch, got ${r1.upstreamStatus}`);

        await new Promise(r => setTimeout(r, 50));

        const r2 = await service.getOrFetch("mock-search", ctxB);
        assert(r2.upstreamStatus === 200, "dogs should miss cache (different body)");
    });

    // -----------------------------------------------------------------------
    // Scenario 5: Circuit breaker opens after sustained failures
    //
    // "mock-fail" is configured with volumeThreshold: 10 and allowWarmUp: false
    // so the breaker can trip quickly in dev. We fire 15 distinct failing requests
    // (different queryParams → different cache keys, no coalescing) then verify
    // the next call throws CircuitOpenError.
    // -----------------------------------------------------------------------
    await scenario("Circuit breaker opens after sustained failures", async () => {
        // Use queryParams to vary the cache key without changing the URL path
        // (uri would append to the path and miss the /mock/fail route handler)
        const requests = Array.from({ length: 15 }, (_, i) =>
            service.getOrFetch("mock-fail", { baseUrl: BASE, queryParams: { id: String(i) } }).catch(() => null)
        );
        await Promise.all(requests);

        let threw = false;
        try {
            await service.getOrFetch("mock-fail", { baseUrl: BASE, queryParams: { id: "probe" } });
        } catch (err) {
            threw = err instanceof CircuitOpenError;
        }
        assert(threw, "Expected CircuitOpenError — breaker should be open after 15 failures");
    });

    // -----------------------------------------------------------------------
    // Scenario 6: Slow upstream still works (within timeout)
    // -----------------------------------------------------------------------
    await scenario("Slow upstream responds within timeout", async () => {
        const ctx: RequestContext = { baseUrl: BASE };
        const r = await service.getOrFetch("mock-slow", ctx);
        assert(r.data !== null, "Expected data from slow upstream");
    });

    // -----------------------------------------------------------------------
    // Summary
    // -----------------------------------------------------------------------
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    console.log("─".repeat(40));

    await client.disconnect().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
    console.error("\nPlayground crashed:", err.message ?? err);
    process.exit(1);
});
