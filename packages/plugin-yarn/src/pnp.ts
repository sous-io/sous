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

    if (file === undefined) return [];

    const api = loadPnp(file);
    const locator = api?.findPackageLocator(`${projectRoot}/`) ?? null;
    const info = locator === null ? null : (api?.getPackageInformation(locator) ?? null);

    // A resolver that cannot be loaded (or does not know the project) still leaves the declared
    // dependencies and the versions yarn.lock resolved them to.
    if (api === undefined || info === null) return lockfileInstalled(projectRoot, file);

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

/**
 * The packages a Plug'n'Play project declares, at the versions the `yarn.lock` beside `.pnp.cjs`
 * resolves them to, for when the resolver itself cannot be asked. Each one's location is the
 * `.pnp.cjs` file, since no copy of it is on disk; a version the lockfile does not hold is
 * `unknown`.
 */
export function lockfileInstalled(projectRoot: string, pnpFile: string): InstalledPackage[] {
    const declaring = readPackageJson(projectRoot);
    let lockfile = "";

    try {
        lockfile = fs.readFileSync(path.join(path.dirname(pnpFile), "yarn.lock"), "utf8");
    } catch {
        // No lockfile: every version is unknown.
    }

    const names = new Set<string>();

    for (const section of ["devDependencies", "dependencies"] as const) {
        const block = declaring?.[section];

        if (block !== null && typeof block === "object") {
            for (const name of Object.keys(block as Record<string, unknown>)) names.add(name);
        }
    }

    return [...names].sort().flatMap((name) => {
        const declared = declaredIn(declaring, name);

        if (declared === undefined) return [];

        return [
            {
                name,
                version: yarnLockVersion(lockfile, name, declared.range) ?? "unknown",
                location: pnpFile,
                realPath: realpathOr(pnpFile),
                isSousPlugin: false,
                declared,
            },
        ];
    });
}

/**
 * The version a Yarn Berry `yarn.lock` resolves a package's declared `range` to. Each entry opens
 * with an unindented key listing its descriptors (`"name@npm:1.2.3", "name@npm:^1.2.0":`) and holds
 * an indented `version:`. When no descriptor matches the range exactly but every entry for the
 * package holds the same version, that version is the answer.
 */
export function yarnLockVersion(lockfile: string, name: string, range: string): string | undefined {
    const prefix = `${name}@`;
    const wanted = new Set([`${prefix}${range}`, `${prefix}npm:${range}`]);
    const entries: Array<{ descriptors: string[]; version?: string }> = [];
    let entry: { descriptors: string[]; version?: string } | undefined;

    for (const line of lockfile.split(/\r?\n/)) {
        if (/^[^\s#].*:$/.test(line)) {
            const descriptors = line
                .slice(0, -1)
                .split(",")
                .map((part) => part.trim().replace(/^"|"$/g, ""))
                .filter((descriptor) => descriptor.startsWith(prefix));

            entry = descriptors.length > 0 ? { descriptors } : undefined;

            if (entry !== undefined) entries.push(entry);

            continue;
        }

        const version = /^\s+version:\s*"?([^"\s]+)"?\s*$/.exec(line);

        if (entry !== undefined && version !== null && entry.version === undefined) {
            entry.version = version[1];
        }
    }

    const exact = entries.find((candidate) => candidate.descriptors.some((descriptor) => wanted.has(descriptor)));

    if (exact !== undefined) return exact.version;

    const versions = new Set(entries.flatMap((candidate) => candidate.version ?? []));

    return versions.size === 1 ? [...versions][0] : undefined;
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
