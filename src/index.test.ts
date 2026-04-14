import { describe, it, expect, afterEach, vi } from "vitest";

// Mock ValkeyClient before any import of index.ts so the module-level
// code never attempts a real Valkey connection.
vi.mock("./core/client", () => {
    const MockValkeyClient = vi.fn(function (this: any) {
        this.connect = vi.fn().mockResolvedValue(null); // simulates Valkey DOWN
        this.disconnect = vi.fn().mockResolvedValue(undefined);
    });
    return { ValkeyClient: MockValkeyClient };
});

import { ValkeyCacheWrapper } from "./index";
import { Logger } from "./types/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ValkeyCacheWrapper — lifecycle", () => {
    afterEach(async () => {
        // Reset singleton state between tests. close() is idempotent.
        await ValkeyCacheWrapper.close();
    });

    // -- pre-init ------------------------------------------------------------

    it("health throws before init", async () => {
        await expect(ValkeyCacheWrapper.health()).rejects.toThrow(
            "VALKEY_NOT_INITIALIZED",
        );
    });

    it("getConnectionStats throws before init", async () => {
        await expect(ValkeyCacheWrapper.getConnectionStats()).rejects.toThrow(
            "VALKEY_NOT_INITIALIZED",
        );
    });

    it("getWithFetch throws before init", async () => {
        await expect(
            ValkeyCacheWrapper.getWithFetch("anything" as any, {} as any),
        ).rejects.toThrow("VALKEY_NOT_INITIALIZED");
    });

    // -- init ----------------------------------------------------------------

    it("init resolves without error", async () => {
        const service = await ValkeyCacheWrapper.init(silentLogger);
        expect(service).toBeDefined();
    });

    it("init returns the same instance on subsequent calls", async () => {
        const first = await ValkeyCacheWrapper.init(silentLogger);
        const second = await ValkeyCacheWrapper.init(silentLogger);
        expect(first).toBe(second);
    });

    // -- post-init -----------------------------------------------------------

    it("health returns DOWN when Valkey is unreachable", async () => {
        await ValkeyCacheWrapper.init(silentLogger);
        const result = await ValkeyCacheWrapper.health();
        expect(result.status).toBe("DOWN");
    });

    it("getConnectionStats returns DOWN when Valkey is unreachable", async () => {
        await ValkeyCacheWrapper.init(silentLogger);
        const result = await ValkeyCacheWrapper.getConnectionStats();
        expect(result.status).toBe("DOWN");
    });

    // -- close + re-init -----------------------------------------------------

    it("close resets state so methods throw again", async () => {
        await ValkeyCacheWrapper.init(silentLogger);
        await ValkeyCacheWrapper.close();

        await expect(ValkeyCacheWrapper.health()).rejects.toThrow(
            "VALKEY_NOT_INITIALIZED",
        );
    });

    it("re-init works after close", async () => {
        await ValkeyCacheWrapper.init(silentLogger);
        await ValkeyCacheWrapper.close();

        const service = await ValkeyCacheWrapper.init(silentLogger);
        expect(service).toBeDefined();

        const result = await ValkeyCacheWrapper.health();
        expect(result.status).toBe("DOWN");
    });

    it("close is idempotent", async () => {
        await ValkeyCacheWrapper.init(silentLogger);
        await ValkeyCacheWrapper.close();
        await ValkeyCacheWrapper.close(); // should not throw
    });
});
