import path from "node:path";
import type { ViteUserConfig } from "vitest/config";

const packagesDir = import.meta.dirname;

/**
 * Every workspace package, resolved to its TypeScript source, so tests never
 * need a build step.
 */
const sourceAliases: Record<string, string> = {
    "@sous-io/core": path.join(packagesDir, "core/src/index.ts"),
    "@sous-io/documents": path.join(packagesDir, "documents/src/index.ts"),
    "@sous-io/plugin-api": path.join(packagesDir, "plugin-api/src/index.ts"),
    "@sous-io/plugin-cli": path.join(packagesDir, "plugin-cli/src/index.ts"),
};

/**
 * The vitest config every package shares: specs co-located under src/ and
 * integration tests under test/, with v8 coverage of src/.
 */
export function sharedConfig(packageDir: string): ViteUserConfig {
    return {
        resolve: { alias: sourceAliases },
        test: {
            name: path.basename(packageDir),
            root: packageDir,
            include: ["src/**/*.spec.ts", "test/**/*.test.ts"],
            environment: "node",
            coverage: {
                provider: "v8",
                include: ["src/**/*.ts"],
                exclude: ["src/**/*.spec.ts"],
            },
        },
    };
}
