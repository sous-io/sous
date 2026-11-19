import { readdirSync } from "node:fs";
import path from "node:path";
import type { ViteUserConfig } from "vitest/config";

const packagesDir = import.meta.dirname;

/**
 * Every workspace package, resolved to its TypeScript source, so tests never
 * need a build step.
 */
const sourceAliases: Record<string, string> = {
    "@sous-io/sous-lib-core": path.join(packagesDir, "sous-lib-core/src/index.ts"),
    "@sous-io/sous-lib-documents": path.join(packagesDir, "sous-lib-documents/src/index.ts"),
    "@sous-io/sous-lib-repository-hosts/testing": path.join(packagesDir, "sous-lib-repository-hosts/src/testing.ts"),
    "@sous-io/sous-lib-repository-hosts": path.join(packagesDir, "sous-lib-repository-hosts/src/index.ts"),
    ...pluginAliases(),
};

/**
 * Every `packages/sous-plugin-*` package (the plugin API and every built-in plugin), by its `@sous-io/...` name: its root and its `types`
 * entry, each resolved to source.
 */
function pluginAliases(): Record<string, string> {
    const aliases: Record<string, string> = {};

    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith("sous-plugin-")) {
            aliases[`@sous-io/${entry.name}/types`] = path.join(packagesDir, entry.name, "src/types.ts");
            aliases[`@sous-io/${entry.name}`] = path.join(packagesDir, entry.name, "src/index.ts");
        }
    }

    return aliases;
}

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
