import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every workspace package has its own vitest config (see packages/vitest.shared.ts).
    projects: ["packages/*/vitest.config.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.spec.ts"],
    },
  },
});
