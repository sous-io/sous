import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.spec.ts", "src/test/**/*.test.ts"],
    exclude: ["src/test/e2e/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.spec.ts", "src/test/**/*"],
    },
  },
});
