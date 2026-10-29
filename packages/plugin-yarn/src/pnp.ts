/**
 * Yarn Plug'n'Play: a project with a `.pnp.cjs` has no `node_modules`, so installed packages and
 * plugin lookup go through the resolver that file exports.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginLocatorEntity } from "@sous-io/plugin-api";
import type { InstalledPackage } from "@sous-io/plugin-update/types";
import type { YarnPnpLocator } from "./types.js";
import { declaredIn, findUp, isSousPlugin, readPackageJson, realpathOr } from "./node-modules.js";

/** The file Yarn Plug'n'Play writes in place of `node_modules`. */
export const PNP_FILE = ".pnp.cjs";

/** The part of Yarn's `pnpapi` sous uses. */
export interface PnpApi {
    findPackageLocator(location: string): { name: string | null; reference: string | null } | null;
    getPackageInformation(locator: { name: string | null; reference: string | null }): {
        packageLocation: string;
        packageDependencies: Map<string, string | [string, string] | null>;
    } | null;
    resolveRequest(request: string, issuer: string | null, options?: object): string | null;
}

/** The nearest `.pnp.cjs` at or above a directory, or `undefined`. */
export function findPnpFile(start: string): string | undefined {
    const dir = findUp(start, (candidate) => fs.existsSync(path.join(candidate, PNP_FILE)));

    return dir === undefined ? undefined : path.join(dir, PNP_FILE);
}

/** Loads the resolver a `.pnp.cjs` exports, or `undefined` when it cannot be loaded. */
export function loadPnp(file: string): PnpApi | undefined {
    try {
        const api = createRequire(file)(file) as Partial<PnpApi> | undefined;

        return api !== undefined && typeof api.resolveRequest === "function" ? (api as PnpApi) : undefined;
    } catch {
        return undefined;
    }
}

/** The version in a Yarn reference: `npm:1.2.3`, `virtual:abc#npm:1.2.3`. */
function versionOfReference(reference: string): string {
    return /npm:([^#:]+)$/.exec(reference)?.[1] ?? "unknown";
}

/** Whether a location is inside one of Yarn's zip archives, which Node cannot read. */
function inZip(location: string): boolean {
    return /\.zip(\/|$)/.test(location);
}

/**
 * The packages the project at `projectRoot` depends on, asked of the Plug'n'Play resolver. A package
 * still in Yarn's zip cache has no readable `package.json`, so it counts as a plugin only when it can
 * be read.
 */
export function pnpInstalled(projectRoot: string): InstalledPackage[] {
    const file = findPnpFile(projectRoot);
    const api = file === undefined ? undefined : loadPnp(file);

    if (api === undefined) return [];

    const locator = api.findPackageLocator(`${projectRoot}/`);
    const info = locator === null ? null : api.getPackageInformation(locator);

    if (info === null) return [];

    const declaring = readPackageJson(projectRoot);
    const installed: InstalledPackage[] = [];

    for (const [name, entry] of [...info.packageDependencies].sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (entry === null) continue;

        const reference = typeof entry === "string" ? entry : entry[1];
        const dependency = api.getPackageInformation({ name, reference });

        if (dependency === null) continue;

        const location = dependency.packageLocation.replace(/\/$/, "");
        const pkg = inZip(location) ? undefined : readPackageJson(location);
        const declared = declaredIn(declaring, name);

        installed.push({
            name,
            version: typeof pkg?.version === "string" ? pkg.version : versionOfReference(reference),
            location,
            realPath: realpathOr(location),
            isSousPlugin: pkg !== undefined && isSousPlugin(pkg),
            ...(declared === undefined ? {} : { declared }),
        });
    }

    return installed;
}

/** Whether a specifier names a package rather than a path or URL. */
function isBare(specifier: string): boolean {
    return !/^(\.{0,2}\/|[a-z][a-z0-9+.-]*:|\.\.?$)/i.test(specifier) && !path.isAbsolute(specifier);
}

/** The `plugin-locator` entity: finds a plugin through Plug'n'Play, only in a Plug'n'Play project. */
export const yarnPnpLocator: YarnPnpLocator = {
    id: "yarn-pnp",

    locate(specifier, context) {
        const root = context.project?.root;

        if (root === undefined || !isBare(specifier)) return undefined;

        const file = findPnpFile(root);
        const api = file === undefined ? undefined : loadPnp(file);

        if (api === undefined) return undefined;

        try {
            const resolved = api.resolveRequest(specifier, `${root}/`);

            // A zip path cannot be imported; leave it to Node's own resolution to say so.
            return resolved === null || inZip(resolved) ? undefined : pathToFileURL(resolved);
        } catch {
            return undefined;
        }
    },
} satisfies PluginLocatorEntity as YarnPnpLocator;
