/**
 * The contract of sous-plugin-init: scaffolding a project's `.sous/`
 * (`sous init`), then building it through the one build path. The project root is the directory
 * holding the new `.sous/`, so the scaffold writes no `projectRoot`.
 *
 * Other plugins import this file type-only.
 */

import type { BuildResult } from "@sous-io/sous-plugin-build/types";

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
    /**
     * Installs the git hooks (`--hooks`) or not (`--no-hooks`). Left out, init asks when the
     * project has a `.git` folder, and `yes` installs them.
     */
    hooks?: boolean;
    /** Also installs the hooks that run after a pull and a rebase (`--pull-hooks`); passed to `init.hooks`. */
    pullHooks?: boolean;
    /** Runs the package manager's install after installing the hooks (`--install`) or not (`--no-install`); passed to `init.hooks`. */
    install?: boolean;
}

/** A git hook `sous init hooks` installs. */
export type GitHookName = "post-checkout" | "post-merge" | "post-rewrite";

/** `init.hooks` (`sous init hooks`). */
export interface InitHooksInput {
    /** The project root, which holds `.sous/`. Default: the project sous found, else the working directory. */
    directory?: string;
    /** Also installs `post-merge` and `post-rewrite`. Left out, it asks; `yes` leaves them out. */
    pullHooks?: boolean;
    /** Runs the package manager's install at the end. Left out, it asks; `yes` runs it. */
    install?: boolean;
    /** Answers every question with its default: no pull hooks, run the install. */
    yes?: boolean;
    dryRun?: boolean;
}

/** One file `init.hooks` wrote, or in a dry run would write. */
export interface HookFileChange {
    readonly file: string;
    /** `created` for a new file, `added` when Sous's block went into an existing one, `updated` when the block was already there and changed. */
    readonly change: "created" | "added" | "updated" | "unchanged";
}

/** What `init.hooks` did. */
export type InitHooksResult =
    | {
          readonly installed: true;
          readonly root: string;
          /** `husky` with a `package.json`, `git` (the repository's hooks folder) without one. */
          readonly via: "husky" | "git";
          readonly hooks: readonly GitHookName[];
          readonly files: readonly HookFileChange[];
          /** The package manager, with a `package.json`. */
          readonly manager?: string;
          /** The command each hook runs. */
          readonly hookCommand: string;
          /** The package script that runs `sous build` after an install, and its text. */
          readonly script?: { readonly name: "prepare" | "postinstall"; readonly text: string };
          /** The package manager's install at the end: run, declined, failed, or not offered. */
          readonly install: { readonly command: string; readonly outcome: "ran" | "failed" | "declined" | "skipped" | "planned"; readonly exitCode?: number } | undefined;
          readonly dryRun: boolean;
      }
    | {
          readonly installed: false;
          readonly root: string;
          /** Why it stopped. */
          readonly reason: string;
          /** The lines to add by hand. */
          readonly manual: readonly string[];
          readonly dryRun: boolean;
      };

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
    /** What `init.hooks` did, when it ran. */
    readonly hooks?: InitHooksResult;
    readonly build?: BuildResult;
    readonly dryRun: boolean;
}

declare module "@sous-io/sous-plugin-api" {
    interface SousIntents {
        init: { input: InitInput; result: InitResult };
        "init.hooks": { input: InitHooksInput; result: InitHooksResult };
    }
}
