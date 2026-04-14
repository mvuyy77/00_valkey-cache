import {
    GlideClient,
    GlideClientConfiguration,
    GlideClusterClient,
    GlideClusterClientConfiguration,
} from '@valkey/valkey-glide';
import { ValidatedConfig, AuthConfigSchema } from '../config/schema';
import { Logger } from '../types/types';

type AnyGlideClient = GlideClient | GlideClusterClient;
type ClusterClient = AnyGlideClient | null;

export class ValkeyClient {
    private config: ValidatedConfig | null = null;
    private client: ClusterClient = null;
    private clientPromise: Promise<ClusterClient> | null = null;

    constructor( private logger: Logger ) {
        this.logger = logger;
        this.validateAndLoadConfig();
    }

    private validateAndLoadConfig() : boolean {
        const env = ( process.env.NODE_APP_INSTANCE || "development" ).toLowerCase();
        const rawConfig = {
            host: process.env.VALKEY_HOST ?? "",
            port: process.env.VALKEY_PORT ?? "",
            tlsInsecure: env === "development" || env === "local",
            lazyConnect: true,
            useTLS: process.env.VALKEY_USE_TLS !== "false",
            clusterMode: process.env.VALKEY_CLUSTER_MODE !== "false",
            connectionTimeout: 5000,
            requestTimeout: 5000,
            inflightRequestsLimit: 700,
            username: process.env.VALKEY_USERNAME,
            password: process.env.VALKEY_PASSWORD
        };

        const parsedConfig = AuthConfigSchema.safeParse(rawConfig);
        if ( !parsedConfig.success ) {
            this.config = null;
            this.errorHandler(parsedConfig.error);
            return false;
        }

        this.config = parsedConfig.data;
        this.logger.info(`VALKEY_CONFIG_VALIDATED: Connected to host - ${ this.config.host}`);
        return true;
    }

    private async initializeValkeyConnection(): Promise<ClusterClient>{
        if ( !this.config ) {
            this.logger.error("VALKEY_CONFIG_ERROR. Please validate config provided.")
            return null;
        }

        try {
            const sharedConfig = {
                addresses: [{
                    host: this.config.host,
                    port: this.config.port
                }],
                useTLS: this.config.useTLS,
                credentials: ( this.config.username && this.config.password )
                    ? { username: this.config.username, password: this.config.password }
                    : undefined,
                advancedConfiguration: {
                    ...(this.config.useTLS && { tlsAdvancedConfiguration: { insecure: this.config.tlsInsecure } }),
                    connectionTimeout: this.config.connectionTimeout
                },
                requestTimeout: this.config.requestTimeout,
                inflightRequestsLimit: this.config.inflightRequestsLimit,
                connectionBackoff: {
                    numberOfRetries: 5,
                    factor: 1000,
                    exponentBase: 2,
                    jitterPercent: 20
                }
            };

            this.logger.debug(`VALKEY_CONNECTION_STARTED: Connection Started (${this.config.clusterMode ? "cluster" : "standalone"} mode)`);

            if (this.config.clusterMode) {
                const clusterConfig: GlideClusterClientConfiguration = {
                    ...sharedConfig,
                    lazyConnect: this.config.lazyConnect,
                };
                this.client = await GlideClusterClient.createClient(clusterConfig);
            } else {
                const standaloneConfig: GlideClientConfiguration = {
                    ...sharedConfig,
                };
                this.client = await GlideClient.createClient(standaloneConfig);
            }

            this.logger.debug(`VALKEY_CONNECTION_SUCCESS: Connection Established!!!`);
            return this.client;
        } catch (error) {
            this.logger.error(`VALKEY_CONNECTION_FAILURE: Connection Issues Encountered!!!`);
            this.errorHandler(error);
            this.client = null;
            this.clientPromise = null;
            return null;
        }
    }

    private async getClient(): Promise<ClusterClient> {
        // Re-validate config on every call when config is missing.
        // This makes the client self-healing: if env vars weren't available
        // at construction time but appear later, the next connect() picks them up.
        if ( !this.config ) {
            this.validateAndLoadConfig();
        }
        if ( !this.config ) return null;
        if ( this.client ) return this.client;
        if ( !this.clientPromise ) {
            this.clientPromise = this.initializeValkeyConnection();
        }

        try {
            return await this.clientPromise;
        } catch (error) {
            this.clientPromise = null;
            this.errorHandler(error);
            return null;
        }
    }

    public async disconnect(): Promise<void>{
        try {
            if ( this.client ) {
                await this.client.close();
                this.logger.info("VALKEY_DISCONNECTED: Connection closed successfully");
            }
        } catch (error) {
            this.errorHandler(error);
        } finally {
            this.client = null;
            this.clientPromise = null;
        }
    }

    public connect(): Promise<ClusterClient> {
        return this.getClient()
    }

    private errorHandler(error: unknown) {
        if ( !error ) return;
        const errorType = ( error instanceof Error ) ? error.name : "UnknownError";
        const errorMessage = ( error instanceof Error ) ? error.message : String(error);
        this.logger.error(`Error Encountered: ${ errorType } - message: ${ errorMessage }`);
    }
}
