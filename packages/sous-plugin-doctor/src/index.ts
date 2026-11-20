/**
 * sous-plugin-doctor: `sous doctor`, which runs every check a plugin adds as a `doctor-check`
 * entity, reports what it found, and offers to fix what it can, asking before each fix.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/sous-plugin-api";
import { BUILT_IN_CHECKS } from "./checks.js";
import type { DoctorCheckEntity, DoctorInput } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-doctor";

/** The `doctor-check` kind's schema. The methods are functions, which JSON Schema cannot describe. */
const doctorCheckSchema = jsonSchema<DoctorCheckEntity>({
    type: "object",
    required: ["id", "order", "description"],
    properties: {
        id: { type: "string", description: "Names the check in the report and in --json." },
        order: { type: "number", description: "Lower runs first; the built-in checks use 100 to 800." },
        description: { type: "string", description: "One sentence saying what is checked, stated as the healthy state." },
        confirm: { type: "boolean", description: "Whether sous doctor asks before running the fix. Default: true." },
    },
});

const doctorInput = jsonSchema<DoctorInput>({
    type: "object",
    properties: {
        dryRun: { type: "boolean", default: false, description: "Report what every check finds and change nothing." },
        yes: { type: "boolean", default: false, description: "Apply every fix without asking, and take the default answer to every migration's question." },
        answer: { type: "array", items: { type: "string" }, description: "Answer a question ahead of time, as <name>=<value>: a migration's question or a recipe variable." },
        only: { type: "array", items: { type: "string" }, description: "Run only this check, by id." },
    },
    additionalProperties: false,
});

/** The plugin. */
export const doctorPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "sous doctor: runs every check, reports what it found, and offers to fix what it can.",

    register(sous) {
        sous.entities.define("doctor-check", doctorCheckSchema, {
            description: "A check sous doctor runs: what it looks at, and how to fix what it finds.",
        });

        for (const check of BUILT_IN_CHECKS) {
            sous.entities.add("doctor-check", check);
        }

        sous.intents.add({
            intent: "doctor",
            summary: "Check this project's health, run pending migrations, and offer to fix each problem found",
            input: doctorInput,
            // A config that does not load is the first thing it reports.
            toleratesConfigErrors: true,
            // The lockfile check reads what each pinned recipe depends on, from its files (#291).
            needsRecipeFiles: true,
            cli: {
                examples: ["sous doctor", "sous doctor --dry-run", "sous doctor --yes", "sous doctor --only outputs", "sous doctor --answer memories.location=keep"],
                flags: { yes: { short: "y", aliases: ["force"] } },
            },
            agent: {
                usage: "Run with dryRun first to see every problem; pass yes (and answer for a question whose default is not wanted) to fix them without prompts.",
            },
            load: () => import("./doctor.js"),
        });
    },
});

export default doctorPlugin;

export { BUILT_IN_CHECKS, configCheck, lockfileCheck, outputsCheck, variablesCheck } from "./checks.js";
export { DOCTOR_CHECK_ORDER } from "./types.js";
export type * from "./types.js";
