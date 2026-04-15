import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: false,
        environment: "node",
        include: ["tests/**/*.test.ts"],
        coverage: {
            provider: "v8",
            include: ["src/**/*.ts"],
            exclude: [
                "tests/**/*.test.ts",
                "src/types/**",
                "src/config/manifest.ts",
                "src/index.ts",
                "src/playground/*",
            ],
            reporter: ["text", "html"],
        },
    },
});
