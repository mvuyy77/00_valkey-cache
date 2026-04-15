// ============================================================
// types/types.ts  (Images 1–2, lines 1–83)
// ============================================================

export type ReadStatus = "HIT" | "MISS" | "ERROR" | "DOWN";
export type WriteStatus = "HIT" | "MISS" | "ERROR" | "DOWN";;
export type HealthStatus = "UP" | "DOWN" | "ERROR";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH";

export interface CachedData<T> {
    data: T;
    cachedAt: number;
}

export interface CacheReadResult<T> {
    status: ReadStatus;
    data: T | null;
    timeElapsed: number;
    error?: unknown;
};

export interface CacheWriteResult {
    cacheKey: string,
    status: WriteStatus;
    timeElapsed: number;
    error?: unknown;
}

export interface HealthCheckResult {
    status: HealthStatus;
    data: string | null;
    timeElapsed: number;
    error?: string | null;
}

export interface KeyExistsResult {
    status: string;
    data: number;
    timeElapsed: number;
    error?: string;
}

export interface ValkeyStats {
    [key: string]: any;
}

export type hashAlgorithm = "md5" | "sha256" | "sha512";

export interface CacheKeyOptions {
    prefix?: string | "cache"
    url: string;
    method?: HttpMethod;
    headers?: Record<string, any | undefined>;
    body?: string | Record<string, unknown> | unknown[];
    hashAlgorithm?: "md5" | "sha256" | "sha512";
}

export interface ServiceManifestConfig {
    serviceName: string,
    method: HttpMethod;
    relativePath: string;
    TTLInSeconds: number;
    apiFetchTimeoutInSeconds: number;
    cacheKeyHeaders?: string[];
    metadata?: Record<string, string>;
}

export interface RequestContext {
    baseUrl: string;
    uri?: string;
    method?: HttpMethod;
    headers?: Record<string, any>;
    body?: Record<string, unknown> | undefined;
    params?: Record<string, string>;
    queryParams?: Record<string, string>;
    apiFetchTimeoutInSeconds?: number;
    requestTimeout?: number;
};

export enum ServiceManifest {
    USER_PROFILE_BY_LOGIN_ID = "getUserProfileByLoginId",
    USER_PROFILE_BY_NMU = "getUserProfileByNMU",
    FIELD_DETAILS_BY_NMU = "getFieldDetailsByFieldNMU",
    AUTH_PROFILE_V2 = "getCXAuthProfile",
    MOCK_SERVICE = "mockService"
};

export interface CacheResponse<T> {
    data: T | null;
    headers: {
        "X-Cache": "HIT" | "MISS";
        "X-Cache-Status": string;
        "X-Cache-Source": "Cache" | "API";
        [key: string]: string;
    };
};

export interface FetchResult<T = unknown> {
    data: T | null;
    upstreamStatus?: number;
}

export interface Logger {
    info: (message: string, ...args: any[]) => void;
    warn: (message: string, ...args: any[]) => void;
    error: (message: string, ...args: any[]) => void;
    debug: (message: string, ...args: any[]) => void;
}

export class CircuitOpenError extends Error {
    readonly status = 503;
    readonly prefix: string;

    constructor(prefix: string) {
        super(`CIRCUIT_OPEN: ${prefix} is unavailable — circuit breaker is open`);
        this.name = "CircuitOpenError";
        this.prefix = prefix;
    }
}
