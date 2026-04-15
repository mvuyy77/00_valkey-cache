import { describe, it, expect } from "vitest";
import { AuthConfigSchema } from "../src/config/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const validConfig = {
    host: "valkey.example.com",
    port: "6379",
    useTLS: true,
    tlsInsecure: false,
    lazyConnect: true,
    requestTimeout: 5000,
    connectionTimeout: 5000,
    inflightRequestsLimit: 1000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthConfigSchema", () => {
    // -- valid inputs --------------------------------------------------------

    it("accepts a fully-specified valid config", () => {
        const result = AuthConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
    });

    it("accepts optional username and password", () => {
        const result = AuthConfigSchema.safeParse({
            ...validConfig,
            username: "admin",
            password: "secret",
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.username).toBe("admin");
            expect(result.data.password).toBe("secret");
        }
    });

    // -- coercion ------------------------------------------------------------

    it("coerces port from string to number", () => {
        const result = AuthConfigSchema.safeParse(validConfig);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.port).toBe(6379);
            expect(typeof result.data.port).toBe("number");
        }
    });

    it("coerces a numeric port value", () => {
        const result = AuthConfigSchema.safeParse({
            ...validConfig,
            port: 6380,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.port).toBe(6380);
        }
    });

    // -- defaults ------------------------------------------------------------

    it("applies defaults when optional fields are omitted", () => {
        const minimal = { host: "valkey.example.com", port: "6379" };
        const result = AuthConfigSchema.safeParse(minimal);
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.useTLS).toBe(true);
            expect(result.data.tlsInsecure).toBe(false);
            expect(result.data.lazyConnect).toBe(true);
            expect(result.data.requestTimeout).toBe(5000);
            expect(result.data.connectionTimeout).toBe(5000);
            expect(result.data.inflightRequestsLimit).toBe(1000);
        }
    });

    // -- invalid inputs ------------------------------------------------------

    it("rejects an empty host", () => {
        const result = AuthConfigSchema.safeParse({
            ...validConfig,
            host: "",
        });
        expect(result.success).toBe(false);
    });

    it("rejects a missing host", () => {
        const { host: _, ...noHost } = validConfig;
        const result = AuthConfigSchema.safeParse(noHost);
        expect(result.success).toBe(false);
    });

    it("rejects a non-numeric port string", () => {
        const result = AuthConfigSchema.safeParse({
            ...validConfig,
            port: "not-a-number",
        });
        expect(result.success).toBe(false);
    });

    it("rejects a missing port", () => {
        const { port: _, ...noPort } = validConfig;
        const result = AuthConfigSchema.safeParse(noPort);
        expect(result.success).toBe(false);
    });
});
