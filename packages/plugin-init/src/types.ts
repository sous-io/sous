/**
 * The contract of plugin-init: scaffolding a project's `.sous/`
 * (`sous init`), then building it through the one build path. The project root is the directory
 * holding the new `.sous/`, so the scaffold writes no `projectRoot`.
 *
 * Other plugins import this file type-only.
 */

import type { BuildResult } from "@sous-io/plugin-build/types";

/** What `init` did to the project's `package.json`. */
export type PackageJsonOutcome =
    | { readonly kind: "already-declared"; readonly section: "dependencies" | "devDependencies"; readonly range: string }
    | { readonly kind: "added"; readonly section: "devDependencies"; readonly range: string }
    | { readonly kind: "no-package-json" };

/** `init`. */
export interface InitInput {
    /** The project root. Default the working directory. */
    directory?: string;
    /** The project's display name. */
    name?: string;
    /** Answers every question with its default, overwriting nothing that exists (`--yes`, `--force`). */
    yes?: boolean;
    /** Moves the files the existing instructions include into `.sous/includes/` (the default). */
    moveIncludes?: boolean;
    /** Copies the files the existing instructions include into `.sous/includes/`, keeping the originals. */
    copyIncludes?: boolean;
    /** Leaves the files the existing instructions include where they are. */
    leaveIncludes?: boolean;
    dryRun?: boolean;
    noBuild?: boolean;
}

/** The result of `init`. */
export interface InitResult {
    readonly root: string;
    readonly sousDir: string;
    readonly configPath: string;
    /** Every file written, absolute. */
    readonly files: readonly string[];
    /** Files left as they were because they existed. */
    readonly kept: readonly string[];
    /** The files the import wrote under `.sous/` (also in `files`), absolute. */
    readonly imported: readonly string[];
    /** Files and folders the import moved into `.sous/`, at their old places, absolute. */
    readonly removed: readonly string[];
    /** Paths git stopped tracking, relative to the project root. */
    readonly untracked: readonly string[];
    readonly packageJson: PackageJsonOutcome;
    readonly build?: BuildResult;
    readonly dryRun: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        init: { input: InitInput; result: InitResult };
    }
}
