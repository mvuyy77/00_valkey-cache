import { describe, it, expect, afterEach, vi } from "vitest";
import { GlideClusterClient } from "@valkey/valkey-glide";
import { ValkeyClient } from "./client";
import { Logger } from "../types/types";

// ---------------------------------------------------------------------------
// Mock @valkey/valkey-glide — replace GlideClusterClient.createClient with
// a vi.fn() so no real connection is attempted.
// ---------------------------------------------------------------------------

vi.mock("@valkey/valkey-glide", () => ({
    GlideClusterClient: {
        createClient: vi.fn(),
    },
}));

const mockCreateClient = vi.mocked(GlideClusterClient.createClient);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const silentLogger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

const spyLogger = (): Logger & { calls: Record<string, string[]> } => {
    const calls: Record<string, string[]> = {
        info: [],
        warn: [],
        error: [],
        debug: [],
    };
    return {
        calls,
        info: (msg: string) => calls.info.push(msg),
        warn: (msg: string) => calls.warn.push(msg),
        error: (msg: string) => calls.error.push(msg),
        debug: (msg: string) => calls.debug.push(msg),
    };
};

/** Stub the minimum env vars needed for config validation to pass. */
const setValidEnv = () => {
    vi.stubEnv("VALKEY_HOST", "valkey.example.com");
    vi.stubEnv("VALKEY_PORT", "6379");
};

type PrivateClient = {
    config: any;
    client: any;
    clientPromise: any;
};

const priv = (c: ValkeyClient) => c as unknown as PrivateClient;

// Minimal fake that satisfies the GlideClusterClient interface for tests
const createFakeGlideClient = () => ({
    get: vi.fn(),
    set: vi.fn(),
    exists: vi.fn(),
    ping: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
    getStatistics: vi.fn(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ValkeyClient — constructor / config validation", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        mockCreateClient.mockReset();
    });

    it("loads config when valid env vars are set", () => {
        setValidEnv();
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config).not.toBeNull();
        expect(priv(client).config.host).toBe("valkey.example.com");
        expect(priv(client).config.port).toBe(6379);
    });

    it("sets config to null when VALKEY_HOST is missing", () => {
        vi.stubEnv("VALKEY_HOST", "");
        vi.stubEnv("VALKEY_PORT", "6379");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config).toBeNull();
    });

    it("sets config to null when VALKEY_PORT is not a number", () => {
        vi.stubEnv("VALKEY_HOST", "valkey.example.com");
        vi.stubEnv("VALKEY_PORT", "not-a-number");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config).toBeNull();
    });

    it("logs the validated host on success", () => {
        setValidEnv();
        const logger = spyLogger();
        new ValkeyClient(logger);

        expect(logger.calls.info.some((m) => m.includes("valkey.example.com"))).toBe(true);
    });

    it("logs an error on config validation failure", () => {
        vi.stubEnv("VALKEY_HOST", "");
        vi.stubEnv("VALKEY_PORT", "6379");
        const logger = spyLogger();
        new ValkeyClient(logger);

        expect(logger.calls.error.length).toBeGreaterThan(0);
    });

    // -- environment-driven TLS settings ------------------------------------

    it("sets tlsInsecure to true in development environment", () => {
        setValidEnv();
        vi.stubEnv("NODE_APP_INSTANCE", "development");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config.tlsInsecure).toBe(true);
    });

    it("sets tlsInsecure to true in local environment", () => {
        setValidEnv();
        vi.stubEnv("NODE_APP_INSTANCE", "local");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config.tlsInsecure).toBe(true);
    });

    it("sets tlsInsecure to false in production environment", () => {
        setValidEnv();
        vi.stubEnv("NODE_APP_INSTANCE", "production");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config.tlsInsecure).toBe(false);
    });

    it("disables TLS when VALKEY_USE_TLS is 'false'", () => {
        setValidEnv();
        vi.stubEnv("VALKEY_USE_TLS", "false");
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config.useTLS).toBe(false);
    });

    it("enables TLS by default", () => {
        setValidEnv();
        const client = new ValkeyClient(silentLogger);

        expect(priv(client).config.useTLS).toBe(true);
    });
});

describe("ValkeyClient — connect()", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        mockCreateClient.mockReset();
    });

    it("returns null when config is invalid and env vars remain bad", async () => {
        vi.stubEnv("VALKEY_HOST", "");
        vi.stubEnv("VALKEY_PORT", "6379");
        const client = new ValkeyClient(silentLogger);

        const result = await client.connect();
        expect(result).toBeNull();
        expect(mockCreateClient).not.toHaveBeenCalled();
    });

    it("self-heals when env vars become available after construction", async () => {
        // Construct with missing env vars — config fails at construction
        vi.stubEnv("VALKEY_HOST", "");
        vi.stubEnv("VALKEY_PORT", "6379");
        const client = new ValkeyClient(silentLogger);
        expect(priv(client).config).toBeNull();

        // First connect returns null
        const first = await client.connect();
        expect(first).toBeNull();

        // Env vars appear (e.g., dotenv loaded late, secret injected)
        vi.stubEnv("VALKEY_HOST", "valkey.example.com");

        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        // Next connect re-validates, picks up the new env vars, connects
        const second = await client.connect();
        expect(second).toBe(fakeGlide);
        expect(priv(client).config).not.toBeNull();
        expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it("does not re-validate when config is already valid", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const logger = spyLogger();
        const client = new ValkeyClient(logger);

        // Constructor logs VALKEY_CONFIG_VALIDATED once
        const infoCountAfterConstruct = logger.calls.info.length;

        await client.connect();
        await client.connect();

        // No additional validation logs — config was reused, not re-validated
        expect(logger.calls.info.length).toBe(infoCountAfterConstruct);
    });

    it("calls GlideClusterClient.createClient on first connect", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);
        const result = await client.connect();

        expect(mockCreateClient).toHaveBeenCalledTimes(1);
        expect(result).toBe(fakeGlide);
    });

    it("returns the same client on subsequent calls (cached)", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);
        const first = await client.connect();
        const second = await client.connect();

        expect(first).toBe(second);
        expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent connect calls", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);
        const [a, b, c] = await Promise.all([
            client.connect(),
            client.connect(),
            client.connect(),
        ]);

        expect(a).toBe(b);
        expect(b).toBe(c);
        expect(mockCreateClient).toHaveBeenCalledTimes(1);
    });

    it("passes credentials when username and password are set", async () => {
        setValidEnv();
        vi.stubEnv("VALKEY_USERNAME", "admin");
        vi.stubEnv("VALKEY_PASSWORD", "s3cret");
        mockCreateClient.mockResolvedValue(createFakeGlideClient() as any);

        const client = new ValkeyClient(silentLogger);
        await client.connect();

        const passedConfig = mockCreateClient.mock.calls[0][0];
        expect(passedConfig.credentials).toEqual({
            username: "admin",
            password: "s3cret",
        });
    });

    it("omits credentials when username or password is missing", async () => {
        setValidEnv();
        mockCreateClient.mockResolvedValue(createFakeGlideClient() as any);

        const client = new ValkeyClient(silentLogger);
        await client.connect();

        const passedConfig = mockCreateClient.mock.calls[0][0];
        expect(passedConfig.credentials).toBeUndefined();
    });

    it("auto-retries on next connect() after a connection failure", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient
            .mockRejectedValueOnce(new Error("ECONNREFUSED"))
            .mockResolvedValueOnce(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);

        const first = await client.connect();
        expect(first).toBeNull();

        // clientPromise is cleared on failure, so the next connect()
        // creates a fresh attempt without requiring disconnect() first.
        const second = await client.connect();
        expect(second).toBe(fakeGlide);
        expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });

    it("passes the correct glide configuration shape", async () => {
        setValidEnv();
        vi.stubEnv("NODE_APP_INSTANCE", "production");
        mockCreateClient.mockResolvedValue(createFakeGlideClient() as any);

        const client = new ValkeyClient(silentLogger);
        await client.connect();

        const passedConfig = mockCreateClient.mock.calls[0][0];
        expect(passedConfig.addresses).toEqual([
            { host: "valkey.example.com", port: 6379 },
        ]);
        expect(passedConfig.useTLS).toBe(true);
        expect(passedConfig.lazyConnect).toBe(true);
        expect(passedConfig.advancedConfiguration).toEqual({
            tlsAdvancedConfiguration: { insecure: false },
            connectionTimeout: 5000,
        });
        expect(passedConfig.requestTimeout).toBe(5000);
        expect(passedConfig.inflightRequestsLimit).toBe(700);
        expect(passedConfig.connectionBackoff).toEqual({
            numberOfRetries: 5,
            factor: 1000,
            exponentBase: 2,
            jitterPercent: 20,
        });
    });
});

describe("ValkeyClient — disconnect()", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        mockCreateClient.mockReset();
    });

    it("calls client.close() when connected", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);
        await client.connect();
        await client.disconnect();

        expect(fakeGlide.close).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when not connected", async () => {
        setValidEnv();
        const client = new ValkeyClient(silentLogger);

        await client.disconnect();
    });

    it("resets state so next connect() creates a fresh client", async () => {
        setValidEnv();
        const firstGlide = createFakeGlideClient();
        const secondGlide = createFakeGlideClient();
        mockCreateClient
            .mockResolvedValueOnce(firstGlide as any)
            .mockResolvedValueOnce(secondGlide as any);

        const client = new ValkeyClient(silentLogger);
        const first = await client.connect();
        expect(first).toBe(firstGlide);

        await client.disconnect();

        const second = await client.connect();
        expect(second).toBe(secondGlide);
        expect(mockCreateClient).toHaveBeenCalledTimes(2);
    });

    it("handles close() errors gracefully", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        fakeGlide.close.mockRejectedValue(new Error("close failed"));
        mockCreateClient.mockResolvedValue(fakeGlide as any);

        const client = new ValkeyClient(silentLogger);
        await client.connect();

        await expect(client.disconnect()).resolves.toBeUndefined();

        expect(priv(client).client).toBeNull();
        expect(priv(client).clientPromise).toBeNull();
    });

    it("logs success message on clean disconnect", async () => {
        setValidEnv();
        const fakeGlide = createFakeGlideClient();
        mockCreateClient.mockResolvedValue(fakeGlide as any);
        const logger = spyLogger();

        const client = new ValkeyClient(logger);
        await client.connect();
        await client.disconnect();

        expect(logger.calls.info.some((m) => m.includes("VALKEY_DISCONNECTED"))).toBe(true);
    });
});
