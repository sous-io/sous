/**
 * Which variables `vars.ask` asks about: the name argument and the `--repo`, `--namespace`,
 * `--recipe` and `--var` flags, each narrowing the pool the next one resolves against.
 *
 * A written name is read by `refs.resolver` (every reading the command line allows), matched
 * against the variables in play, and settled by `refs.picker` when it means more than one thing
 * (`--accept-first` takes the first; a run that cannot ask fails naming that flag).
 *
 * ```text
 * sous vars ask taskFileRoot                 one variable
 * sous vars ask SOUS_VAR_TASK_FILE_ROOT      the variable that name answers
 * sous vars ask task-files                   every question one recipe asks
 * sous vars ask workflow                     every question one namespace asks
 * sous vars ask sous-recipes                 every question one repository asks
 * ```
 */

import { ConfigError, isSousErrorOfKind, NonInteractiveError, type Prompter, type Reporter, type ServiceReader } from "@sous-io/plugin-api";
import type { RefKind, SousRef } from "@sous-io/plugin-refs/types";
import { recipeKey } from "./definitions.js";
import type { Ladder } from "./ladder.js";
import { matchVariables, narrowTo } from "./matching.js";
import type { DefinedVariable, VarsAskInput } from "./types.js";

/** The line every "this matched nothing" error ends with. */
export const SEE_ALL = "Run 'sous vars' to see every variable this project's recipes define.";

/** What resolving a selection uses. */
export interface SelectionIo {
    readonly services: Pick<ServiceReader, "get">;
    readonly prompter: Prompter;
    readonly reporter: Reporter;
}

/** What this run asks about, in words. */
export function describeSelection(input: VarsAskInput): string {
    const parts: string[] = [];

    if (input.repo !== undefined) parts.push(`the repository '${input.repo}'`);
    if (input.namespace !== undefined) parts.push(`the namespace '${input.namespace}'`);
    if (input.recipe !== undefined) parts.push(`the recipe '${input.recipe}'`);
    if (input.name !== undefined) parts.push(`'${input.name}'`);

    for (const wanted of input.var ?? []) {
        parts.push(`the variable '${wanted}'`);
    }

    if (parts.length === 0) {
        return input.all === true ? "every variable" : "everything unanswered";
    }

    return parts.join(", ");
}

/**
 * The keys of the variables to ask, or `undefined` when nothing narrows anything. A step that
 * leaves nothing is an error naming what did it.
 */
export async function resolveSelection(pool: readonly DefinedVariable[], ladder: Ladder, input: VarsAskInput, io: SelectionIo): Promise<Set<string> | undefined> {
    const { name, repo, namespace, recipe } = input;
    const vars = input.var;

    if (name === undefined && repo === undefined && namespace === undefined && recipe === undefined && vars === undefined) {
        return undefined;
    }

    let left: DefinedVariable[] = [...pool];
    const pick = (search: string, kinds?: readonly RefKind[]) => pickOne(search, left, ladder, kinds, input.acceptFirst === true, io);

    if (repo !== undefined) {
        left = narrowTo(left, await pick(repo, ["repo"]));
    }

    if (namespace !== undefined) {
        left = narrowTo(left, await pick(namespace, ["namespace"]));
    }

    if (recipe !== undefined) {
        // `subscription.add` passes the exact `namespace/recipe` key; anything else is a ref.
        const exact = left.filter((entry) => recipeKey(entry.recipe) === recipe);

        left = exact.length > 0 ? exact : narrowTo(left, await pick(recipe, ["recipe"]));
    }

    if (name !== undefined) {
        left = narrowTo(left, await pick(name));
    }

    if (vars !== undefined) {
        const chosen: DefinedVariable[] = [];

        for (const wanted of vars) {
            chosen.push(...narrowTo(left, await pick(wanted, ["variable", "envVar"])));
        }

        left = chosen;
    }

    if (left.length === 0) {
        throw new ConfigError(`Nothing is left to ask: ${describeSelection({ ...input, all: false })} names no variable this project holds.`, { details: [SEE_ALL] });
    }

    return new Set(left.map((entry) => entry.key));
}

/** Every known ref a written name could mean among the pool, best first. */
export function candidatesFor(search: string, pool: readonly DefinedVariable[], ladder: Ladder, kinds: readonly RefKind[] | undefined, services: Pick<ServiceReader, "get">): SousRef[] {
    let readings: SousRef[];

    try {
        readings = services.get("refs.resolver").parse(search, "commandLine").refs;
    } catch {
        // A ref the command line refuses in every reading names nothing here.
        readings = [];
    }

    const found = new Map<string, { ref: SousRef; exact: boolean }>();

    for (const reading of readings) {
        if (kinds !== undefined && !kinds.includes(reading.kind)) {
            continue;
        }

        for (const match of matchVariables(pool, reading, ladder)) {
            const key = `${match.ref.kind} ${JSON.stringify(match.ref)}`;

            if (!found.has(key)) {
                found.set(key, { ref: match.ref, exact: match.exactSpelling });
            }
        }
    }

    // Exact spellings first; then a name that answers several variables is one candidate per
    // variable, so choosing between them is choosing between variables.
    const all = [...found.values()];
    const best = all.some((entry) => entry.exact) ? all.filter((entry) => entry.exact) : all;

    return best.flatMap(({ ref }) => (ref.kind === "envVar" && (ref.variables?.length ?? 0) > 1 ? ref.variables!.map((variable): SousRef => ({ ...ref, variables: [variable] })) : [ref]));
}

/** Settles the one ref a written name means, through `refs.picker`. */
async function pickOne(search: string, pool: readonly DefinedVariable[], ladder: Ladder, kinds: readonly RefKind[] | undefined, acceptFirst: boolean, io: SelectionIo): Promise<SousRef> {
    const candidates = candidatesFor(search, pool, ladder, kinds, io.services);

    if (candidates.length === 0) {
        throw new ConfigError(`Nothing called '${search}' was found.`, { details: [SEE_ALL] });
    }

    if (candidates.length === 1) {
        return candidates[0]!;
    }

    try {
        return await io.services.get("refs.picker").pick(candidates, { search, acceptFirst, announce: false, details: [SEE_ALL] }, io);
    } catch (error) {
        throw isSousErrorOfKind(error, "non-interactive") ? ambiguityError(search, error as NonInteractiveError) : error;
    }
}

/**
 * The picker's "cannot ask" error, worded as before the refactor: it says the question was which
 * thing the name meant, keeps the candidates and the fix, and exits 1 (nothing was typed wrong).
 */
function ambiguityError(search: string, cause: NonInteractiveError): NonInteractiveError {
    const error = new NonInteractiveError(cause.question, cause.answeredBy, { cause, details: cause.details, exitCode: 1 });

    error.message = `Sous has to ask which '${search}' you meant, and it is not running where it can ask.`;

    return error;
}
