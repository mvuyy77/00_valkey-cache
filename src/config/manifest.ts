import { ServiceManifest, ServiceManifestConfig } from "../types/types";

const API_KEY = process.env.MS_API_KEY;

export const SERVICES_MANIFEST: Partial<Record<ServiceManifest, ServiceManifestConfig>> = {
    [ServiceManifest.USER_PROFILE_BY_LOGIN_ID]: {
        method: "GET",
        relativePath: "/profile/loginid",
        staticHeaders: {
            apikey: API_KEY
        },
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.USER_PROFILE_BY_NMU]: {
        method: "GET",
        relativePath: "/profile/",
        staticHeaders: {
            apikey: API_KEY
        },
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.FIELD_DETAILS_BY_NMU]: {
        method: "GET",
        relativePath: "/field/",
        staticHeaders: {
            apikey: API_KEY
        },
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.AUTH_PROFILE_V2]: {
        method: "GET",
        relativePath: "/v1/auth-profile",
        staticHeaders: {
            apikey: API_KEY
        },
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.MOCK_SERVICE]: {
        method: "GET",
        relativePath: "/mock-service",
        staticHeaders: {
            apikey: API_KEY
        },
        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    }
}