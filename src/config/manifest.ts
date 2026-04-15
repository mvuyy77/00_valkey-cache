import { ServiceManifest, ServiceManifestConfig } from "../types/types";

export const SERVICES_MANIFEST: Partial<Record<ServiceManifest, ServiceManifestConfig>> = {
    [ServiceManifest.USER_PROFILE_BY_LOGIN_ID]: {
        serviceName: "nmlvhub-ms-userprofile",
        method: "GET",
        relativePath: "/profile/loginid",

        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.USER_PROFILE_BY_NMU]: {
        serviceName: "nmlvhub-ms-userprofile",
        method: "GET",
        relativePath: "/profile/",

        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.FIELD_DETAILS_BY_NMU]: {
        serviceName: "nmlvhub-ms-field",
        method: "GET",
        relativePath: "/field/",

        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.AUTH_PROFILE_V2]: {
        serviceName: "ms-authprofile-v2",
        method: "GET",
        relativePath: "/v1/auth-profile",

        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    },
    [ServiceManifest.MOCK_SERVICE]: {
        serviceName: "mock-service",
        method: "GET",
        relativePath: "/mock-service",

        TTLInSeconds: 300,
        apiFetchTimeoutInSeconds: 5
    }
}