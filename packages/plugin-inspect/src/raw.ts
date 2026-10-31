/**
 * Config files as written, for `--raw`. The files
 * are read through `config-files.loader`, which already read them for this build, so `--raw` shows
 * exactly the text the build used.
 */

import path from "node:path";
import type { ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import "@sous-io/plugin-confd/types";
import "@sous-io/plugin-config-files/types";
import { KEY_NAME_POLICY, redactText, type SecretPolicy } from "./redact.js";
import type { RawConfigFile } from "./types.js";

/** The contributor of the main config file. */
const MAIN_CONTRIBUTOR = "config-files.main";

/** The prefix of the contributors of the patch files beside the main config file. */
const MAIN_PATCH_PREFIX = "config-files/";

/** One file to show: who reads it, and where it is. */
interface ConfigFileRef {
    readonly contributor: string;
    readonly path: string;
}

/** The main config file, its patch files, then each `conf.d` file in name order. */
function configFiles(project: ProjectInfo, services: ServiceReader): ConfigFileRef[] {
    const files: ConfigFileRef[] = [];
    const loader = services.has("config-files.loader") ? services.get("config-files.loader") : undefined;

    if (project.configPath !== undefined) {
        files.push({ contributor: MAIN_CONTRIBUTOR, path: project.configPath });
    }

    for (const file of loader?.findPatches(project.sousDir) ?? []) {
        files.push({ contributor: `${MAIN_PATCH_PREFIX}${path.basename(file)}`, path: file });
    }

    if (services.has("confd.files")) {
        files.push(...services.get("confd.files").list());
    }

    return files;
}

/** Each config file as written, in the order the build reads them, with secrets hidden. */
export async function readRawConfigFiles(
    project: ProjectInfo | undefined,
    services: ServiceReader,
    policy: SecretPolicy = KEY_NAME_POLICY,
): Promise<RawConfigFile[]> {
    if (project === undefined || !services.has("config-files.loader")) {
        return [];
    }

    const loader = services.get("config-files.loader");
    const raw: RawConfigFile[] = [];

    for (const file of configFiles(project, services)) {
        try {
            const loaded = await loader.load(file.path);

            raw.push({ contributor: file.contributor, path: file.path, text: redactText(loaded.text, policy) });
        } catch {
            // A file gone since the build, or one that no longer parses, has nothing to show.
        }
    }

    return raw;
}
