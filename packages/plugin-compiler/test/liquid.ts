/**
 * Registering the compiler's `liquid-tag` and `liquid-filter` entities on a bare LiquidJS engine,
 * as plugin-liquid does, under the names today's specs call (`registerShowVarsTag(engine)`), so
 * those specs port with their imports changed and nothing else.
 */

import type { Liquid } from "liquidjs";
import type { EntityReader, ServiceReader } from "@sous-io/plugin-api";
import type { LiquidExtensionContext, LiquidFilterEntity, LiquidTagEntity } from "@sous-io/plugin-liquid/types";
import { globFiles as globFilesWith, type GlobFilesOptions } from "../src/liquid/glob-files.js";
import { bulletListFilter, exportScalarVarsJsTag, getFilesTag, listFilesTag, showVarsTag } from "../src/liquid/tags.js";
import { testGlobs, testSecrets } from "./stand-ins.js";

/** The secret names each engine was told, kept live so `setSecretNames` works after registering. */
const secretNames = new WeakMap<Liquid, Set<string>>();

function namesFor(engine: Liquid): Set<string> {
    let names = secretNames.get(engine);

    if (!names) {
        names = new Set();
        secretNames.set(engine, names);
    }

    return names;
}

/** Services the tags use: `host.globs`, and `variables.secrets` for the secret heuristics. */
const available: Record<string, unknown> = { "host.globs": testGlobs, "variables.secrets": testSecrets() };
const services: ServiceReader = {
    get: ((name: string) => {
        if (name in available) {
            return available[name];
        }

        throw new Error(`No service ${name} in this test.`);
    }) as ServiceReader["get"],
    has: (name) => name in available,
};

const entities = { get: () => undefined, list: () => [], has: () => false, describe: () => [], kinds: () => [] } as unknown as EntityReader;

function contextFor(engine: Liquid): LiquidExtensionContext {
    return { project: undefined, env: {}, services, entities, purpose: "template", secretNames: namesFor(engine), data: {} };
}

function tagRegistrar(entity: LiquidTagEntity): (engine: Liquid) => void {
    return (engine) => engine.registerTag(entity.id, entity.tag(contextFor(engine)));
}

function filterRegistrar(entity: LiquidFilterEntity): (engine: Liquid) => void {
    return (engine) => engine.registerFilter(entity.id, entity.filter(contextFor(engine)));
}

export const registerShowVarsTag = tagRegistrar(showVarsTag);
export const registerExportScalarVarsJsTag = tagRegistrar(exportScalarVarsJsTag);
export const registerGetFilesTag = tagRegistrar(getFilesTag);
export const registerListFilesTag = tagRegistrar(listFilesTag);
export const registerBulletListFilter = filterRegistrar(bulletListFilter);

/** Records the names declared secret for one engine. */
export function setSecretNames(engine: Liquid, names: Iterable<string>): void {
    const live = namesFor(engine);

    live.clear();

    for (const name of names) {
        live.add(name);
    }
}

/** `globFiles` over the test's `host.globs`. */
export function globFiles(options: GlobFilesOptions) {
    return globFilesWith(testGlobs, options);
}
