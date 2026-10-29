import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // The pre-1.0 CLI under src/: kept passing until the new packages replace it.
        test: {
          name: "legacy",
          include: ["src/**/*.spec.ts", "src/test/**/*.test.ts"],
          exclude: ["src/test/e2e/**"],
          environment: "node",
        },
      },
      "packages/*/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/test/**/*", "packages/*/src/**/*.spec.ts"],
    },
  },
});
