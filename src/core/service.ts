import { createHash } from "node:crypto";
import pLimit from "p-limit";
import CircuitBreaker from "opossum";
import { pack, unpack } from "msgpackr";
import { Decoder, TimeUnit } from "@valkey/valkey-glide";
import {
	HealthCheckResult,
	CacheReadResult,
	CacheWriteResult,
	KeyExistsResult,
	ValkeyStats,
	RequestContext,
	ServiceManifestConfig,
	FetchResult,
	Logger,
	CircuitOpenError,
} from "../types/types";
import { DEFAULT_TTL_IN_SECONDS } from "../config/schema";
import { ValkeyClient } from "./client";


export class ValkeyService {
	private requestsInFlight = new Map<string, Promise<any>>();
	private limit = pLimit(100);
	private MAX_QUEUE_SIZE = 500;
	private breakers = new Map<string, CircuitBreaker>();

	constructor(
		private client: ValkeyClient,
		private manifest: Record<string, ServiceManifestConfig>,
		private logger: Logger,
	) {}

	private getBreakerFor(prefix: string): CircuitBreaker {
		let breaker = this.breakers.get(prefix);
		if (!breaker) {
			breaker = new CircuitBreaker(this.performFetch, {
				allowWarmUp: true,
				volumeThreshold: 100,
				timeout: 10000,
				errorThresholdPercentage: 50,
				resetTimeout: 30000,
				// Only 429 and 5xx count as breaker failures.
				// 401, 403, 499 are thrown but filtered — not the upstream's fault.
				errorFilter: (err: any) => err.status && err.status !== 429 && err.status < 500,
			});
			this.registerBreakerEvents(prefix, breaker);
			this.breakers.set(prefix, breaker);
		}
		return breaker;
	}

	private registerBreakerEvents(prefix: string, breaker: CircuitBreaker): void {
		breaker.on("open", () =>
			this.logger.error(`CIRCUIT_OPEN: ${prefix} — error threshold exceeded, requests suspended`));
		breaker.on("halfOpen", () =>
			this.logger.warn(`CIRCUIT_HALF_OPEN: ${prefix} — probing upstream`));
		breaker.on("close", () =>
			this.logger.info(`CIRCUIT_CLOSED: ${prefix} — upstream recovered`));
		breaker.on("timeout", () =>
			this.logger.warn(`CIRCUIT_TIMEOUT: ${prefix} — request timed out`));
		breaker.on("reject", () =>
			this.logger.warn(`CIRCUIT_REJECT: ${prefix} — request rejected, circuit is open`));
	}

	private calculateTimeElapsed(startTime: number): number {
		return parseFloat(((Date.now() - startTime) / 1000).toFixed(3));
	}

	private hasRequestBody(ctx: RequestContext): boolean {
		if (ctx.method?.toUpperCase() === "GET") return false;
		if (ctx.body === null || ctx.body === undefined) return false;
		if (Array.isArray(ctx.body)) return ctx.body.length > 0;
		if (typeof ctx.body === "object") return Object.keys(ctx.body).length > 0;
		return true;
	}

	private selectHeadersForCacheKey(
		headers: Record<string, string>,
		cacheKeyHeaders: string[],
	): Record<string, string> {
		if (cacheKeyHeaders.length === 0) return {};
		const lowered: Record<string, string> = {};
		for (const [k, v] of Object.entries(headers)) {
			lowered[k.toLowerCase()] = v;
		}
		const result: Record<string, string> = {};
		for (const key of cacheKeyHeaders) {
			const lower = key.toLowerCase();
			if (lower in lowered) result[lower] = lowered[lower];
		}
		return result;
	}

	public async getFromCache(
		cacheKey: string,
	): Promise<CacheReadResult<Buffer> | null> {
		const startTime = Date.now();
		try {
			const client = await this.client.connect();
			if (!client) {
				return {
					status: "DOWN",
					data: null,
					timeElapsed: this.calculateTimeElapsed(startTime),
					error: "VALKEY_ERROR - not connected to Valkey",
				};
			}

			const cachedValue = (await client.get(cacheKey, {
				decoder: Decoder.Bytes,
			})) as Buffer | null;

			if (!cachedValue) {
				return {
					status: "MISS",
					data: null,
					timeElapsed: this.calculateTimeElapsed(startTime),
					error: null,
				};
			}

			return {
				status: "HIT",
				data: cachedValue,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: null,
			};
		} catch (err) {
			return {
				status: "ERROR",
				data: null,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	public async setToCache(
		cacheKey: string,
		data: Buffer,
		ttlInSeconds?: number,
	): Promise<CacheWriteResult | null> {
		const startTime = Date.now();
		const client = await this.client.connect();
		if (!client) {
			return {
				cacheKey,
				status: "DOWN",
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: "VALKEY_ERROR - not connected to Valkey",
			};
		}

		try {
			const cachedValue = await client.set(cacheKey, data, {
				expiry: {
					count: ttlInSeconds ? ttlInSeconds : DEFAULT_TTL_IN_SECONDS,
					type: TimeUnit.Seconds,
				},
				conditionalSet: "onlyIfDoesNotExist", // NOTE: never overwrites existing keys
			});
			if (cachedValue === "OK") {
				return {
					status: "HIT",
					cacheKey,
					timeElapsed: this.calculateTimeElapsed(startTime),
					error: null,
				};
			}

			return {
				status: "MISS",
				cacheKey,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: `VALKEY_ERROR - Unable to setCache - ${cachedValue}`,
			};
		} catch (err: unknown) {
			return {
				status: "ERROR",
				cacheKey,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	public async health(): Promise<HealthCheckResult> {
		const startTime = Date.now();
		try {
			const client = await this.client.connect();
			if (!client) {
				return {
					status: "DOWN",
					data: null,
					timeElapsed: this.calculateTimeElapsed(startTime),
					error: "VALKEY_ERROR - not connected to Valkey",
				};
			}

			const response = await client.ping();
			return {
				status: response === "PONG" ? "UP" : "DOWN",
				data: response as string,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: null,
			};
		} catch (err) {
			return {
				status: "ERROR",
				data: null,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	public async keyExists(cacheKey: string[]): Promise<KeyExistsResult> {
		const startTime = Date.now();
		const client = await this.client.connect();
		if (!client) {
			return {
				status: "ERROR",
				data: 0,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: "VALKEY_ERROR - not connected to Valkey",
			};
		}

		try {
			const count: number = await client.exists(cacheKey);
			return {
				status: count > 0 ? "HIT" : "MISS",
				data: count,
				timeElapsed: this.calculateTimeElapsed(startTime),
			};
		} catch (err: unknown) {
			return {
				status: "ERROR",
				data: 0,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	public async getStats(): Promise<ValkeyStats> {
		const startTime = Date.now();
		const client = await this.client.connect();
		if (!client) {
			return {
				status: "DOWN",
				data: null,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: "VALKEY_ERROR - not connected to Valkey",
			};
		}

		try {
			const stats = client.getStatistics();
			return {
				status: stats ? "HIT" : "MISS",
				data: stats,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: null,
			};
		} catch (err: unknown) {
			return {
				status: "ERROR",
				data: null,
				timeElapsed: this.calculateTimeElapsed(startTime),
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	private buildUpstreamUrl(prefix: string, ctx: RequestContext): string {
		const base = (process.env.GATEWAY_URL || ctx.baseUrl).replace(/\/+$/, "");
		let path = this.manifest[prefix].relativePath;

		if (ctx.params) {
			for (const [key, value] of Object.entries(ctx.params)) {
				path = path.replace(`{${key}}`, encodeURIComponent(value));
			}
		}
		const unresolved = path.match(/\{(\w+)\}/);
		if (unresolved) {
			throw new Error(`UNRESOLVED_PATH_PARAM: {${unresolved[1]}} in "${path}"`);
		}

		if (ctx.uri) path += ctx.uri;

		if (ctx.queryParams && Object.keys(ctx.queryParams).length > 0) {
			const qs = Object.entries(ctx.queryParams)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
				.join("&");
			path += `?${qs}`;
		}

		return `${base}${path}`;
	}

	private generateCacheKey(prefix: string, ctx: RequestContext): string {
		const method = this.manifest[prefix].method;
		const cacheKeyHeaders = this.manifest[prefix].cacheKeyHeaders ?? [];
		const url = this.buildUpstreamUrl(prefix, ctx);
		const hashAlgorithm = "sha256";

		let rawKey = `${prefix}:${method.toLowerCase()}:${url}`;
		const selectedHeaders = this.selectHeadersForCacheKey(ctx.headers ?? {}, cacheKeyHeaders);
		const headerKeys = Object.keys(selectedHeaders);

		if (headerKeys.length > 0) {
			const hkeyString = headerKeys
				.sort()
				.map((hkey) => `${hkey}:${selectedHeaders[hkey] ?? ""}`)
				.join("|");
			rawKey += `|headers:${hkeyString}`;
		}

		if (this.hasRequestBody(ctx)) {
			const hashedRequestBody = this.hashRequestBody(ctx.body, hashAlgorithm);
			if (hashedRequestBody) rawKey += `|requestBody:${hashedRequestBody}`;
		}

		return `${prefix}:${createHash(hashAlgorithm).update(rawKey).digest("hex")}`;
	}

	public async getOrFetch<T>(
		prefix: string,
		ctx: RequestContext,
	): Promise<FetchResult<T>> {
		const manifest = this.manifest[prefix];
		if (!manifest) throw new Error(`PREFIX_NOT_FOUND: ${prefix}`);

		const cacheKey = this.generateCacheKey(prefix, ctx);
		let existing = this.requestsInFlight.get(cacheKey);
		if (existing) return existing as Promise<FetchResult<T>>;

		const fetchInProgress = (async (): Promise<FetchResult<T>> => {
			try {
				const startTime = Date.now();
				const connectedClient = await this.client.connect();
				const isConnected = connectedClient !== null;
				if (isConnected && manifest.TTLInSeconds > 0) {
					const readFromCache = await this.getFromCache(cacheKey);
					if (readFromCache?.status === "HIT" && readFromCache.data) {
						this.logger.debug(
							`VALKEY_CACHE_HIT: ${prefix} - time elapsed: ${this.calculateTimeElapsed(startTime)}`,
						);
						// Data is stored as msgpack — unpack is faster than JSON.parse
						// and avoids converting the Buffer to a string first.
						return { data: unpack(readFromCache.data) as T };
					}
				}

				// Warn at 80% capacity so overload is visible before requests start failing.
				if (this.limit.pendingCount >= this.MAX_QUEUE_SIZE * 0.8) {
					this.logger.warn(
						`Service approaching overload. Queued requests: ${this.limit.pendingCount}`,
					);
				}
				if (this.limit.pendingCount >= this.MAX_QUEUE_SIZE) {
					this.logger.error(
						`Service Overload. Queued requests: ${this.limit.pendingCount}`,
					);
					throw new Error("HTTP 503 - Service OverLoad");
				}

				const result = (await this.limit(() =>
					this.getBreakerFor(prefix).fire(prefix, ctx),
				)) as { status: number; data: Buffer | null };

				// Other 4xx — performFetch returned { status, data: null } without throwing.
				// Pass through to consumer with the upstream status code.
				if (!result.data) {
					return { data: null, upstreamStatus: result.status };
				}

				// Parse JSON once here rather than storing raw bytes and re-parsing on every cache HIT.
				const parsed = JSON.parse(result.data.toString()) as T;

				if (isConnected) {
					// Store as msgpack instead of raw JSON bytes:
					// - more compact on disk/memory in Valkey
					// - faster to deserialize on cache HITs (unpack vs JSON.parse)
					const packed = Buffer.from(pack(parsed));
					this.setToCache(
						cacheKey,
						packed,
						this.manifest[prefix].TTLInSeconds,
					).catch((error) => {
						this.logger.error(
							`VALKEY_BACKPRESSURE: Cache write failed for key - ${cacheKey}`,
							error.message,
						);
					});
				}

				return { data: parsed, upstreamStatus: result.status };
			} catch (error: any) {
				if (error?.message === "Breaker is open") {
					throw new CircuitOpenError(prefix);
				}
				this.logger.error(`API_FETCH_ERROR - ${cacheKey}`, error);
				throw error;
			} finally {
				this.requestsInFlight.delete(cacheKey);
			}
		})();

		this.requestsInFlight.set(cacheKey, fetchInProgress);
		return fetchInProgress;
	}

	private performFetch = async (
		prefix: string,
		options: RequestContext,
	): Promise<{ status: number; data: Buffer | null }> => {
		const fetchUrl = this.buildUpstreamUrl(prefix, options);
		const response = await fetch(fetchUrl, {
			method: options.method,
			headers: {
				...this.manifest[prefix].staticHeaders,
				...options.headers,
			},
			body: options.body ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(
				(options.apiFetchTimeoutInSeconds || 5) * 1000,
			),
		});

		// 2xx — success, return data
		if (response.ok) {
			// response.bytes() returns a Uint8Array directly (Node 22+).
			// Wrapping via the underlying ArrayBuffer avoids copying the data a second time,
			// unlike Buffer.from(await response.arrayBuffer()) which allocates twice.
			const bytes = await response.bytes();
			return {
				status: response.status,
				data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			};
		}

		// 401, 403 — auth failure. Throw so the consumer handles it.
		// Breaker does NOT count these (errorFilter).
		if (response.status === 401 || response.status === 403) {
			const error = new Error(`API_AUTH_ERROR - HTTP ${response.status}`) as any;
			error.status = response.status;
			throw error;
		}

		// 429 — rate limited. Throw so the breaker counts it and opens.
		if (response.status === 429) {
			const error = new Error(`API_RATE_LIMITED - HTTP 429`) as any;
			error.status = 429;
			throw error;
		}

		// 499 — client closed request. Throw but breaker does NOT count it.
		if (response.status === 499) {
			const error = new Error(`API_CLIENT_CLOSED - HTTP 499`) as any;
			error.status = 499;
			throw error;
		}

		// Other 4xx — client error. Return as data so the consumer decides.
		// Breaker never sees these (they don't throw).
		if (response.status >= 400 && response.status < 500) {
			return { status: response.status, data: null };
		}

		// 5xx — upstream broken. Throw so the breaker counts it.
		const error = new Error(`API_ERROR - HTTP ${response.status}`) as any;
		error.status = response.status;
		throw error;
	};

	private hashRequestBody(body: any, hashAlgorithm: string): string | null {
		if (body == null) return null;
		// Produce a canonical JSON string with sorted keys at every level so that
		// { a:1, b:2 } and { b:2, a:1 } hash identically. The string is hashed directly —
		// no JSON.parse or pack round-trip needed.
		const canonical = JSON.stringify(body, (_, v) =>
			v !== null && typeof v === "object" && !Array.isArray(v)
				? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
				: v
		);
		return createHash(hashAlgorithm).update(canonical).digest("hex");
	}
}
