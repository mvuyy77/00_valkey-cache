import { ValkeyClient } from "./core/client";
import { ValkeyService } from "./core/service";
import { SERVICES_MANIFEST } from "./config/manifest";
import { RequestContext, ServiceManifest, Logger } from "./types/types";

/***
 * Flow: On first `init(logger)`
 * 1. Logger is captured once for the lifetime of the singleton
 * 2. ValkeyClient + ValkeyService are constructed
 * 3. client.connect() is fired; callers may optionally await the returned promise
 * 4. Subsequent calls to any method reuse the same client/service
 */
let client: ValkeyClient | null = null;
let service: ValkeyService | null = null;
let capturedLogger: Logger | null = null;
let initPromise: Promise<ValkeyService> | null = null;

const requireService = (): Promise<ValkeyService> => {
    if ( !initPromise ) {
        throw new Error("VALKEY_NOT_INITIALIZED: Call ValkeyCacheWrapper.init(logger) before using the cache.");
    }
    return initPromise;
};

const startInit = (logger: Logger): Promise<ValkeyService> => {
    if ( initPromise ) return initPromise;

    capturedLogger = logger;
    initPromise = (async () => {
        client = new ValkeyClient(logger);
        service = new ValkeyService(client, SERVICES_MANIFEST, logger);

        // Non-blocking warmup: failures are logged but do not reject the init promise,
        // so `getOrFetch` can still degrade to origin fetches.
        try {
            await client.connect();
        } catch (error) {
            logger.error("VALKEY_CONNECTION_ERROR: ", error);
        }

        return service;
    })();

    return initPromise;
};

export const ValkeyCacheWrapper = {

    // Captures the logger and kicks off the initial connection.
    // Returns the warmup promise so callers can optionally `await` it.
    init: (logger: Logger): Promise<ValkeyService> => startInit(logger),

    health: async () => (await requireService()).health(),

    getConnectionStats: async () => (await requireService()).getStats(),

    close: async () => {
        if ( client ) {
            capturedLogger?.debug("VALKEY_CONNECTION ... Closing Connection Pool....");
            const closing = client;
            client = null;
            service = null;
            initPromise = null;
            capturedLogger = null;
            await closing.disconnect();
        }
    },

    getWithFetch: async <T>(services: ServiceManifest, requestContext: RequestContext) => {
        return (await requireService()).getOrFetch<T>(services, requestContext);
    },
};

export { SERVICES_MANIFEST } from "./config/manifest";
export * from "./types/types"
