/**
 * The checks `sous doctor` runs that need nothing beyond what other plugins already offer: the
 * config loads, the lockfile agrees with the subscriptions, required recipe variables have
 * answers, and the files sous wrote are still there as it wrote them. Each reads through the
 * owner of what it checks (`recipes.lock`, `recipes.resolver`, `vars.list`, `compiler.state`)
 * and skips itself when that owner is not loaded.
 *
 * The other checks spec 24 lists are added by the plugins that own them, at the orders in
 * `DOCTOR_CHECK_ORDER`: pending migrations (the migrations plugin), git hooks, `check` handlers
 * and assertions.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { SousError, type Context } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-recipes/types";
import type {} from "@sous-io/sous-plugin-recipe-answers/types";
import type {} from "@sous-io/sous-plugin-compiler/types";
import type {} from "@sous-io/sous-plugin-build/types";
import { DOCTOR_CHECK_ORDER, type DoctorCheckEntity, type DoctorCheckResult, type DoctorRun } from "./types.js";

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** The result a check gives when the config did not build, since the config check reports that. */
const CONFIG_FAILED: DoctorCheckResult = { status: "skipped", summary: "Skipped: the config did not load." };

/** The result a check gives outside a project. */
const NO_PROJECT: DoctorCheckResult = { status: "skipped", summary: "Skipped: sous is not running in a project." };

/** Whether a service is there to read (a plugin can be switched off). */
function has(ctx: Context, name: string): boolean {
    return ctx.services.has(name as never);
}

/** The config loads: the config build succeeded. */
export const configCheck: DoctorCheckEntity = {
    id: "config",
    order: DOCTOR_CHECK_ORDER.config,
    description: "The config loads",
    check(ctx) {
        const error = ctx.engine.configError;

        if (error === undefined) {
            return { status: "ok" };
        }

        const details = error instanceof SousError ? [...error.details] : [];

        return {
            status: "problem",
            summary: `The config did not load: ${messageOf(error)}`,
            details,
            ...(ctx.project?.configPath === undefined ? {} : { hint: `The config file is ${ctx.project.configPath}.` }),
        };
    },
};

/** One lockfile change, as a line of the check's details. */
function describeChange(change: { key: string; from?: string; to?: string; holder?: string }, kind: "added" | "removed" | "updated"): string {
    const forHolder = change.holder === undefined ? "" : ` for ${change.holder}`;

    switch (kind) {
        case "added":
            return `${change.key} ${change.to ?? ""}${forHolder} is not pinned, and a subscription needs it`;
        case "removed":
            return `${change.key} ${change.from ?? ""}${forHolder} is pinned, and no subscription needs it`;
        default:
            return `${change.key}${forHolder} is pinned at ${change.from ?? "?"}, and the subscriptions now need ${change.to ?? "?"}`;
    }
}

/**
 * Works out the lockfile the subscriptions make, holding every pin while its range allows it, so
 * the only differences are ones the subscriptions call for.
 */
async function lockfileTheSubscriptionsMake(ctx: Context) {
    const lock = ctx.services.get("recipes.lock");
    const before = lock.read();
    const result = await ctx.services.get("recipes.resolver").resolveSubscriptions({ ...lock.held(before), quiet: true });
    const after = lock.fromResolved(result.resolved, before);

    return { lock, before, after, result, diff: lock.diff(before, after) };
}

/** The lockfile agrees with the subscriptions: nothing to add, remove or move. */
export const lockfileCheck: DoctorCheckEntity = {
    id: "lockfile",
    order: DOCTOR_CHECK_ORDER.lockfile,
    description: "The lockfile agrees with the subscriptions",
    async check(ctx, run) {
        if (run.configFailed) {
            return CONFIG_FAILED;
        }

        if (ctx.project === undefined) {
            return NO_PROJECT;
        }

        if (!has(ctx, "recipes.lock") || !has(ctx, "recipes.resolver")) {
            return { status: "skipped", summary: "Skipped: the recipes plugin is not loaded." };
        }

        const { result, diff, lock } = await lockfileTheSubscriptionsMake(ctx);

        if (result.missingRepos.length > 0) {
            return {
                status: "problem",
                summary: "The subscriptions need repositories this project does not trust.",
                details: result.missingRepos.map((missing) => `${missing.name}${missing.url === undefined ? "" : ` (${missing.url})`}, needed by ${missing.requiredBy.map((entry) => entry.ref).join(", ")}`),
                hint: "Trusting a repository is a decision for a person: add each with 'sous repo add <url>'.",
            };
        }

        if (diff.unchanged) {
            return { status: "ok" };
        }

        return {
            status: "problem",
            summary: `The lockfile (${lock.path()}) does not match the subscriptions.`,
            details: [
                ...diff.added.map((change) => describeChange(change, "added")),
                ...diff.removed.map((change) => describeChange(change, "removed")),
                ...diff.updated.map((change) => describeChange(change, "updated")),
                ...diff.reposAdded.map((name) => `The repository ${name} is not in the lockfile, and a subscription needs it`),
                ...diff.reposRemoved.map((name) => `The repository ${name} is in the lockfile, and no subscription needs it`),
            ],
            fix: "Write the lockfile the subscriptions make, keeping every pin their ranges still allow",
        };
    },
    async fix(ctx) {
        const { lock, after, diff } = await lockfileTheSubscriptionsMake(ctx);

        await lock.write(after);
        ctx.configChanged();

        const changes = diff.added.length + diff.removed.length + diff.updated.length;

        return { summary: `The lockfile was written again with ${changes === 1 ? "1 change" : `${changes} changes`}: ${lock.path()}.` };
    },
};

/** One variable as `vars.list` lists it: only what this check reads. */
interface ListedVariable {
    readonly answered: boolean;
    readonly value?: string;
    readonly variable: { readonly key: string; readonly unanswerable?: string; readonly definition: { readonly required?: boolean } };
}

/**
 * The `--answer` entries of `sous doctor` meant for recipe variables: every one but those naming a
 * migration's question, since `sous doctor` takes one `--answer` list for both.
 */
function variableAnswers(ctx: Context, answers: readonly string[]): string[] {
    if (!ctx.entities.kinds().includes("migration")) {
        return [...answers];
    }

    const migrations = ctx.entities.list("migration" as never) as unknown as ReadonlyArray<{ questions?: ReadonlyArray<{ id: string }> }>;
    const ids = new Set(migrations.flatMap((migration) => (migration.questions ?? []).map((question) => question.id)));

    return answers.filter((entry) => !ids.has(entry.slice(0, Math.max(0, entry.indexOf("="))).trim()));
}

/** Required recipe variables have answers: none is required, unanswered and without a default. */
export const variablesCheck: DoctorCheckEntity = {
    id: "variables",
    order: DOCTOR_CHECK_ORDER.variables,
    description: "Required recipe variables have answers",
    async check(ctx, run) {
        if (run.configFailed) {
            return CONFIG_FAILED;
        }

        if (ctx.project === undefined) {
            return NO_PROJECT;
        }

        if (ctx.engine.intents.get("vars.list") === undefined) {
            return { status: "skipped", summary: "Skipped: no plugin lists recipe variables." };
        }

        const listed = (await ctx.run("vars.list", {})).toPlain() as { variables?: readonly ListedVariable[] };
        const missing = (listed.variables ?? []).filter(
            (entry) => entry.variable.definition.required === true && !entry.answered && entry.value === undefined && entry.variable.unanswerable === undefined,
        );

        if (missing.length === 0) {
            return { status: "ok" };
        }

        return {
            status: "problem",
            summary: missing.length === 1 ? "1 required recipe variable has no answer." : `${missing.length} required recipe variables have no answer.`,
            details: missing.map((entry) => entry.variable.key),
            fix: "Answer them now",
            hint: "Answer each with 'sous vars ask', or pass --answer <name>=<value> to sous doctor.",
        };
    },
    async fix(ctx, run) {
        const answers = variableAnswers(ctx, run.answers);

        await ctx.run("vars.ask", { ...(answers.length === 0 ? {} : { answer: answers }), ...(run.yes ? { yes: true } : {}) });

        return { summary: "The variables were asked." };
    },
};

/** The SHA-256 of a file's text, as the compiler's state file records it. */
function hashOf(file: string): string {
    return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8"), "utf8").digest("hex");
}

/**
 * The files sous wrote are still there as it wrote them. A file that is missing, or whose content
 * is no longer what sous wrote, is put right by the next build.
 */
export const outputsCheck: DoctorCheckEntity = {
    id: "outputs",
    order: DOCTOR_CHECK_ORDER.outputs,
    description: "The files sous wrote are present and unchanged",
    check(ctx, run) {
        if (run.configFailed) {
            return CONFIG_FAILED;
        }

        if (ctx.project === undefined) {
            return NO_PROJECT;
        }

        if (!has(ctx, "compiler.state")) {
            return { status: "skipped", summary: "Skipped: the compiler is not loaded." };
        }

        const missing: string[] = [];
        const changed: string[] = [];

        for (const entry of ctx.services.get("compiler.state").entries()) {
            if (!fs.existsSync(entry.dest)) {
                missing.push(entry.dest);
                continue;
            }

            try {
                if (hashOf(entry.dest) !== entry.destHash) {
                    changed.push(entry.dest);
                }
            } catch {
                changed.push(entry.dest);
            }
        }

        if (missing.length === 0 && changed.length === 0) {
            return { status: "ok" };
        }

        const count = missing.length + changed.length;

        return {
            status: "problem",
            summary: `${count === 1 ? "1 file" : `${count} files`} sous wrote ${count === 1 ? "is" : "are"} missing or no longer what sous wrote.`,
            details: [...missing.map((file) => `${file} is missing`), ...changed.map((file) => `${file} has changed since sous wrote it`)],
            fix: "Build the project, which writes them again",
        };
    },
    async fix(ctx) {
        await ctx.run("build", {});

        return { summary: "The project was built." };
    },
};

/** Every check this plugin adds, in order. */
export const BUILT_IN_CHECKS: readonly DoctorCheckEntity[] = [configCheck, lockfileCheck, variablesCheck, outputsCheck];

export type { DoctorRun };
