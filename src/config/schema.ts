import { z } from "zod";

export const DEFAULT_TTL_IN_SECONDS = 300;
export const DEFAULT_API_CALL_TIMEOUT_SECONDS = 5;

const BaseConfigSchema = z.object({
	host: z.string().min(1, "Please provide host value"),
	port: z.coerce
		.number({
			error: "Please provide a valid port number",
		})
		.int(), // https://zod.dev/api?id=coercion
	useTLS: z.boolean().default(true),
	tlsInsecure: z.boolean().default(false),
	clusterMode: z.boolean().default(true),
	lazyConnect: z.boolean().default(true), // https://github.com/valkey-io/valkey-glide/wiki/General-Co
	requestTimeout: z.number().int().optional().default(5000), // default is 250ms // https://glide.valkey.io/langua
	connectionTimeout: z.number().int().optional().default(5000),
	inflightRequestsLimit: z.number().int().optional().default(1000), // https://github.com/valkey-io/valkey-
});

export const AuthConfigSchema = BaseConfigSchema.extend({
	username: z.string().optional(),
	password: z.string().optional(),
});

export type ValidatedConfig = z.infer<typeof AuthConfigSchema>;
