/**
 * The `#` names: the built-in names an include line, a `{% render %}` path or
 * an `entryGlob` may start with, such as `#project`.
 *
 * `~` keeps meaning the home directory and recipe namespaces; `#` is for names
 * sous or a plugin provides. Each name is registered once, with the directories
 * it stands for, and a registration that repeats a name is an error naming both
 * registrants. A later layer registers a view the same way.
 *
 * A plugin adds a name by binding one more `HashName` under
 * `REF_TOKENS.HashName` on a container it builds with `createRefContainer()`.
 */

import { ConfigError } from "../../lib/errors.js";
import { compareBytewise } from "./glob.js";
import { makeInjectable } from "./injectable.js";
import { REF_TOKENS } from "./tokens.js";

/** One file a view lists: where it sits in the view, and the real file behind it. */
export interface ViewFile {
  /** The path inside the view, without the `#name/` prefix, with `/` separators. */
  readonly path: string;
  /** The real file's absolute path. */
  readonly file: string;
}

/** What a view needs to know about the project to list its files. */
export interface HashViewContext {
  /** The project's `.sous/` directory. */
  sousDir: string;
  /** The environment to read; decides where the recipe store is. */
  env?: NodeJS.ProcessEnv;
  /** The merged project config, read for the `recipes` key. */
  settings: {
    recipes?: { memories?: { first?: string[] | undefined; exclude?: string[] | undefined } };
  };
}

/** One `#` name and what it stands for. */
export interface HashName {
  /** The name without its `#`: lowercase kebab-case, such as `project`. */
  readonly name: string;
  /** Who registers it, for the error a duplicate raises (`sous`, or a plugin's name). */
  readonly registeredBy: string;
  /** What the name is, in one sentence. */
  readonly description: string;
  /**
   * The directories the name stands for, in the order they are tried. A path
   * after the name is looked up under each in turn, the first that exists
   * wins. Empty when the name has nothing to stand for in this project.
   *
   * @param scope - The settings scope the project's paths come from.
   */
  bases(scope: Record<string, string>): string[];
  /**
   * A view lists virtual files instead of standing for directories: an include
   * of `#name/<glob>` selects among the listed paths and includes the real
   * files behind them, in the listed order. A view has no bases.
   *
   * @param context - The project the files are listed for.
   */
  view?(context: HashViewContext): ViewFile[];
}

/** The characters a registered name may hold. */
const VALID_NAME = /^[a-z][a-z0-9-]*$/;

/** The built-in `#project`: the consuming project's root. */
export class ProjectHashName implements HashName {
  readonly name = "project";
  readonly registeredBy = "sous";
  readonly description = "the root directory of the project being built.";

  bases(scope: Record<string, string>): string[] {
    return scope.projectRoot ? [scope.projectRoot] : [];
  }
}

makeInjectable(ProjectHashName);

/** Every registered `#` name. */
export class HashNameRegistry {
  private readonly entries = new Map<string, HashName>();

  /**
   * @param names - The names to register, each once.
   * @throws A ConfigError when a name is invalid or registered twice.
   */
  constructor(names: HashName[] = []) {
    for (const entry of names) this.register(entry);
  }

  /**
   * Adds a name.
   *
   * @param entry - The name to add.
   * @throws A ConfigError naming both registrants when the name is already taken.
   */
  register(entry: HashName): void {
    if (!VALID_NAME.test(entry.name)) {
      throw new ConfigError(
        `The name '#${entry.name}' registered by '${entry.registeredBy}' is invalid: a name is ` +
          "lowercase kebab-case, a letter then letters, digits or hyphens."
      );
    }
    const existing = this.entries.get(entry.name);
    if (existing !== undefined) {
      throw new ConfigError(
        `The name '#${entry.name}' is registered twice: by '${existing.registeredBy}' and by ` +
          `'${entry.registeredBy}'.`
      );
    }
    this.entries.set(entry.name, entry);
  }

  /** The registered name, or undefined. */
  get(name: string): HashName | undefined {
    return this.entries.get(name);
  }

  /** Every registered name, sorted. */
  list(): HashName[] {
    return [...this.entries.values()].sort((left, right) => compareBytewise(left.name, right.name));
  }

  /**
   * Every view's listed files, keyed by the name with its `#`.
   *
   * @param context - The project the files are listed for.
   */
  viewMap(context: HashViewContext): Record<string, ViewFile[]> {
    const map: Record<string, ViewFile[]> = {};
    for (const entry of this.list()) {
      if (entry.view !== undefined) map[`#${entry.name}`] = entry.view(context);
    }
    return map;
  }

  /**
   * The alias map the registered names make for a project: `#name` to its
   * directories, leaving out a name with none.
   *
   * @param scope - The settings scope the project's paths come from.
   */
  aliasMap(scope: Record<string, string>): Record<string, string[]> {
    const map: Record<string, string[]> = {};
    for (const entry of this.list()) {
      const bases = entry.bases(scope);
      if (bases.length > 0) map[`#${entry.name}`] = bases;
    }
    return map;
  }
}

makeInjectable(HashNameRegistry, [{ multi: REF_TOKENS.HashName }]);
