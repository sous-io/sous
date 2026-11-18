/**
 * The `compiler.var-overrides` contributor: applies `compilation.varOverrides` to the files
 * `compiler.files` listed. Each rule sets variables on every listed file whose destination matches
 * its `match` and none of its `exclude`; the variables go on the file's entry
 * (`compilation.files[n]._vars`), so `sous config show` shows them and `--layers` names this
 * contributor.
 *
 * A rule's variables win over the output's own `_vars` (the compiler lays them over the output's
 * scope). When several rules match one file, a later rule wins for a name both set. A rule is
 * matched against the path Sous planned to write, before any transform, because the variables are
 * decided before the file is rendered and a transform runs after.
 */

import path from "node:path";
import type { ContributorDefinition, ServiceReader } from "@sous-io/plugin-api";
import { compilePatternList } from "@sous-io/plugin-host";
import type { VarScope, VariablesResolver } from "@sous-io/plugin-variables/types";
import { FILES_CONTRIBUTOR, LISTING_STAGE } from "./files.js";
import type { CompilationFile, CompilationFileProblem, CompilationVarOverride } from "./types.js";

/** The contributor's id. */
export const VAR_OVERRIDES_CONTRIBUTOR = "compiler.var-overrides";

/** One rule, ready to match a path. */
interface CompiledRule {
    readonly matches: (file: string) => boolean;
    readonly vars: Readonly<Record<string, string>>;
}

/** What matching needs. */
export interface OverrideEnvironment {
    readonly resolver: Pick<VariablesResolver, "substituteStrict" | "normalizePath">;
    /** The compilation-level scope, which `${var}` in a glob is substituted from. */
    readonly scope: VarScope;
    /** How a glob matches a path: `host.globs.isMatch`. */
    readonly isMatch: (file: string, pattern: string) => boolean;
    /** A relative glob is relative to it. */
    readonly projectRoot: string;
}

/** The entries as one list or one value. */
function listOf(value: string | readonly string[] | undefined): string[] {
    return value === undefined ? [] : typeof value === "string" ? [value] : [...value];
}

/** A path with `/` separators, which globs and the regular expressions match against. */
function posix(file: string): string {
    return file.split(path.sep).join("/");
}

/**
 * One rule as a matcher. A glob has its `${var}` substituted and is made absolute against the
 * project root; a regular expression (`/.../`) is used as written.
 *
 * @throws When a glob names a variable no one sets, or a regular expression does not compile.
 */
function compileRule(rule: CompilationVarOverride, index: number, env: OverrideEnvironment): CompiledRule {
    const where = `compilation.varOverrides[${index}]`;
    const prepare = (entries: string[], key: string) =>
        entries.map((entry, at) => {
            if (entry.length >= 3 && entry.startsWith("/") && entry.endsWith("/")) {
                return entry;
            }

            const substituted = env.resolver.normalizePath(env.resolver.substituteStrict(entry, env.scope, `${where}.${key}[${at}]`));

            return posix(path.isAbsolute(substituted) ? substituted : path.join(env.projectRoot, substituted));
        });
    const match = compilePatternList(prepare(listOf(rule.match), "match"), `${where}.match`, env.isMatch);
    const exclude = compilePatternList(prepare(listOf(rule.exclude), "exclude"), `${where}.exclude`, env.isMatch);

    return { matches: (file) => match(file) && !exclude(file), vars: rule._vars ?? {} };
}

/** What applying the rules found: each file's variables by its index, and the rules that failed. */
export interface OverrideResult {
    readonly vars: Map<number, Record<string, string>>;
    readonly problems: CompilationFileProblem[];
}

/**
 * Works out each file's variables from the rules: every matching rule's, later rules winning.
 *
 * ```ts
 * applyOverrides([{ match: "/p/.claude/**", _vars: { tool: "claude" } }], files, env).vars;
 * // -> Map { 0 => { tool: "claude" } }   for files[0].destination "/p/.claude/skills/x/SKILL.md"
 * ```
 */
export function applyOverrides(rules: readonly CompilationVarOverride[], files: readonly CompilationFile[], env: OverrideEnvironment): OverrideResult {
    const problems: CompilationFileProblem[] = [];
    const compiled = rules.flatMap((rule, index) => {
        try {
            return [compileRule(rule, index, env)];
        } catch (error) {
            problems.push({ level: "error", message: `compilation.varOverrides[${index}] is not applied: ${error instanceof Error ? error.message : String(error)}` });

            return [];
        }
    });
    const vars = new Map<number, Record<string, string>>();

    if (compiled.length === 0) {
        return { vars, problems };
    }

    files.forEach((file, index) => {
        const destination = posix(file.destination);
        let merged: Record<string, string> | undefined;

        for (const rule of compiled) {
            if (rule.matches(destination)) {
                merged = { ...merged, ...rule.vars };
            }
        }

        if (merged !== undefined) {
            vars.set(index, merged);
        }
    });

    return { vars, problems };
}

/** The `compiler.var-overrides` contributor. It runs after the files are listed. */
export function varOverridesContributor(options: { readonly services: ServiceReader }): ContributorDefinition {
    return {
        id: VAR_OVERRIDES_CONTRIBUTOR,
        stage: LISTING_STAGE,
        after: ["*", FILES_CONTRIBUTOR],
        contribute(config) {
            const rules = config.atPath(["compilation", "varOverrides"]).get<CompilationVarOverride[]>();

            if (!Array.isArray(rules) || rules.length === 0) {
                return;
            }

            const files = config.atPath(["compilation", "files"]).get<CompilationFile[]>() ?? [];
            const resolver = options.services.get("variables.resolver");
            const globs = options.services.get("host.globs");
            const { vars, problems } = applyOverrides(rules, files, {
                resolver,
                scope: resolver.scopeIn(config, { level: "compilation" }),
                isMatch: (file, pattern) => globs.isMatch(file, pattern, { dot: true }),
                projectRoot: config.project?.root ?? path.resolve("/"),
            });

            for (const [index, values] of vars) {
                config.atPath(["compilation", "files", index, "_vars"]).set(values);
            }

            // Reported when a build runs, with the problems listing the files found.
            for (const problem of problems) {
                config.atPath(["compilation", "listing", "problems"]).append(problem);
            }
        },
    };
}
