/**
 * The `config.set` intent: one value written into a config file, surgically, so comments, key order
 * and formatting stay. The engine rebuilds the config after it.
 */

import fs from "node:fs";
import path from "node:path";
import { parseDocument, parsePath, toPlainJson } from "@sous-io/documents";
import { type Context, InputError, IntentOutputs, type JsonValue, type ProjectInfo, SousError } from "@sous-io/plugin-api";
import { writeFileAtomically } from "./env/env-file.js";
import { mainCandidates } from "./loader.js";
import { formatOf, MAIN_CONFIG_FILE_NAMES } from "./names.js";
import type { ConfigSetInput, ConfigSetResult } from "./types.js";

/** The intent's name. */
export const CONFIG_SET = "config.set";

/** The file a new main config is written as. */
const NEW_MAIN_NAME = "sous.config.jsonc";

/**
 * Parses a value from the command line: JSON when it is valid JSON, else the text itself.
 *
 * ```ts
 * parseCliValue("false");     // false
 * parseCliValue("[1, 2]");    // [1, 2]
 * parseCliValue("hello");     // "hello"
 * ```
 */
export function parseCliValue(text: string): JsonValue {
    try {
        return toPlainJson(JSON.parse(text)) ?? text;
    } catch {
        return text;
    }
}

/**
 * The file `config.set` writes: `sous.config.*` by default; a bare file name is looked for in
 * `conf.d` (or names a main config file); anything else is a path from the project root.
 */
export function resolveSetTarget(project: ProjectInfo, file: string | undefined): string {
    if (file === undefined || file === "") {
        return project.configPath ?? mainCandidates(project.sousDir)[0] ?? path.join(project.sousDir, NEW_MAIN_NAME);
    }

    if (path.isAbsolute(file)) {
        return file;
    }

    if (!file.includes("/") && !file.includes(path.sep)) {
        const inConfd = path.join(project.confDir, file);

        if (fs.existsSync(inConfd) || !(MAIN_CONFIG_FILE_NAMES as readonly string[]).includes(file)) {
            return inConfd;
        }

        return path.join(project.sousDir, file);
    }

    return path.resolve(project.root, file);
}

/** One sentence saying what `config.set` did, or would do in a dry run. */
function describeSet(result: ConfigSetResult): string {
    const removing = result.value === undefined;

    if (!result.changed) {
        return removing ? `${result.path} is not set in ${result.file}, so nothing changed.` : `${result.path} already has that value in ${result.file}, so nothing changed.`;
    }

    const change = removing ? `${result.path} removed` : `${result.path} set to ${JSON.stringify(result.value)}`;

    return result.dryRun ? `Would change ${result.file}: ${change}.` : `Changed ${result.file}: ${change}.`;
}

/** Runs `config.set`. */
export async function configSet(input: ConfigSetInput, ctx: Pick<Context, "project">): Promise<IntentOutputs<ConfigSetResult>> {
    const project = ctx.project;

    if (project === undefined) {
        throw new SousError("There is no sous project here, so there is no config file to change.", {
            details: ["Run sous init in the project root first."],
        });
    }

    let segments;

    try {
        segments = parsePath(input.path);
    } catch (error) {
        throw new InputError(CONFIG_SET, [{ path: "path", message: (error as Error).message }]);
    }

    if (segments.length === 0) {
        throw new InputError(CONFIG_SET, [{ path: "path", message: "Name a key, such as compilation.includeSourceComments." }]);
    }

    if (input.unset !== true && input.value === undefined) {
        throw new InputError(CONFIG_SET, [{ path: "value", message: "Give a value, or --unset to remove the key." }]);
    }

    const file = resolveSetTarget(project, input.file);
    const format = formatOf(path.basename(file));

    if (format !== "json" && format !== "jsonc" && format !== "yaml") {
        throw new InputError(CONFIG_SET, [
            {
                path: "file",
                message: `${path.basename(file)} is not a JSON, JSONC or YAML file, so sous cannot edit it. Pass --file to name one that is, such as a conf.d file.`,
            },
        ]);
    }

    const exists = fs.existsSync(file);
    const text = exists ? fs.readFileSync(file, "utf8") : format === "yaml" ? "" : "{}\n";
    let document;

    try {
        document = parseDocument(text, format);
    } catch (error) {
        throw new SousError(`Could not read ${file}: ${(error as Error).message}`, { cause: error });
    }

    const node = document.atPath(segments);
    const previous = node.get();
    const value = input.unset === true ? undefined : parseCliValue(input.value!);

    if (value === undefined) {
        if (previous !== undefined) {
            node.delete();
        }
    } else {
        node.set(value);
    }

    let after = document.toString();

    if (after !== "" && !after.endsWith("\n")) {
        after += "\n";
    }

    const changed = after !== text;
    const dryRun = input.dryRun === true;

    if (changed && !dryRun) {
        writeFileAtomically(file, after, 0o644);
    }

    const result: ConfigSetResult = { file, path: input.path, previous, value, changed, dryRun };

    return IntentOutputs.of<ConfigSetResult>(result, { summary: describeSet(result) });
}
