import { defineConfig, mergeConfig } from "vitest/config";
import { sharedConfig } from "../vitest.shared.js";

export default mergeConfig(
    sharedConfig(import.meta.dirname),
    defineConfig({
        test: {
            // The integration tests run the bundled bin, so it is built before any test.
            globalSetup: ["./test/global-setup.ts"],
            testTimeout: 60_000,
            // Time-budget warnings are off: a busy test machine runs slow, and the tests check output.
            env: { SOUS_BUDGETS: "off" },
            hookTimeout: 120_000,
        },
    }),
);
