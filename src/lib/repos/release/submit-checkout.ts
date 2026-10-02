/**
 * Which working copy `sous repo submit` proposes from.
 *
 * Inside a recipe repository with no argument, it is that repository, as it
 * always was. Inside a project, the argument names a repository the project
 * knows (resolved through `src/services/ref-resolver/`, like every reference), and the
 * submission runs in that repository's checkout:
 *
 *   - a linked repository is read from the checkout its link points at;
 *   - a repository no longer linked, whose checkout sous cloned is still where
 *     `sous repo link` puts one, is submitted from that checkout, with a note
 *     saying it is not linked here;
 *   - a repository with no checkout at all cannot be submitted from, and the
 *     error says there is no working copy to propose from.
 *
 * With no argument inside a project, exactly one linked repository is used and
 * named; several are a question, which a run with no terminal cannot ask.
 *
 * Nothing here writes anything. It reads the links maps and looks at the disk.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../errors.js";
import { nonInteractiveError } from "../../interactive.js";
import {
  CatalogLookup,
  RefPickArguments,
  RefResolveArguments,
  locationFromUrl,
  repoOf,
  sharedRefPicker,
  sharedRefResolver,
  type CatalogRepo,
} from "../../../services/ref-resolver/index.js";
import type { RepoEntry } from "../../settings.js";
import { isGitCheckout, remoteUrlOf, repoSlugFromUrl, sameRemote } from "../git-clone.js";
import { globalReposDir, projectReposDir, readEffectiveLinks } from "../links.js";
import { askChoice } from "../../../utils/prompts.js";
import { findRepoRoot } from "./validate.js";

/** The project a submission may be run from, when one was found. */
export type SubmitProject = {
  /** The project's discovered `.sous/` directory. */
  sousDir: string;
  /** The repositories the project uses, keyed by short name. */
  repos: Record<string, RepoEntry>;
};

/** What `findSubmitCheckout` needs to know. */
export type FindSubmitCheckoutOptions = {
  /** The working directory the command was run from. */
  cwd: string;
  /** The repository the command line named, when it named one. */
  repo?: string;
  /** The project around the working directory, when there is one. */
  project?: SubmitProject;
  /** Whether a question may be asked. */
  interactive: boolean;
  /** The environment, for the machine-wide links map and checkouts. */
  env?: NodeJS.ProcessEnv;
  /** How a choice between several linked repositories is asked. */
  choose?: (message: string, names: string[]) => Promise<string>;
  /** Where the facts about a resolved reference are written. */
  write?: (message: string) => void;
};

/** The working copy a submission runs in, and how it was chosen. */
export type SubmitCheckout = {
  /** The checkout's root directory. */
  rootDir: string;
  /** The project's short name for the repository, when a project named it. */
  repo?: string;
  /** How the checkout was found, in one sentence, ready to print. */
  reason: string;
  /** Anything else worth saying about it, such as a checkout that is no longer linked. */
  notes: string[];
};

/**
 * Works out which checkout a submission runs in.
 *
 * @param options - The working directory, the argument, the project and the testing seams.
 */
export async function findSubmitCheckout(
  options: FindSubmitCheckoutOptions
): Promise<SubmitCheckout> {
  const { cwd, project } = options;
  const env = options.env ?? process.env;

  if (options.repo === undefined) {
    const inside = recipeRepoAround(cwd);
    if (inside !== undefined) {
      return { rootDir: inside, reason: "The working directory is inside it.", notes: [] };
    }
    if (project === undefined) {
      // Neither a recipe repository nor a project: the recipe repository error
      // is the one that says what to do.
      findRepoRoot(cwd);
    }
    return chooseLinked(project!, env, options);
  }

  if (project === undefined) {
    throw new ConfigError(
      `'${options.repo}' names a repository a project uses, but ${path.resolve(cwd)} is not ` +
        `inside a sous project.\n` +
        `  Run the command from inside the project that links the repository, or from inside ` +
        `the repository's own checkout with no argument.`
    );
  }

  const links = readEffectiveLinks(project.sousDir, env);
  const reference = referenceRepos(project, links);
  const { refs } = await sharedRefResolver().resolve(
    new RefResolveArguments({
      input: options.repo,
      lookup: new CatalogLookup(reference),
      kinds: ["repo"],
      refusedIsEmpty: true,
    })
  );
  const match = await sharedRefPicker().pick(
    refs,
    new RefPickArguments({
      search: options.repo,
      interactive: options.interactive,
      ...(options.write === undefined ? {} : { write: options.write }),
      details: [
        reference.length === 0
          ? "  This project uses no repositories."
          : `  This project uses: ${reference.map((entry) => entry.name).join(", ")}.`,
      ],
    })
  );
  const name = repoOf(match)!.name!;

  const link = links[name];
  if (link !== undefined) {
    if (!fs.existsSync(link.path)) {
      throw noWorkingCopy(name, `Its link points at ${link.path}, which does not exist.`);
    }
    return {
      rootDir: link.path,
      repo: name,
      reason: `'${name}' is linked to this checkout.`,
      notes: [],
    };
  }

  const leftover = leftoverCheckout(name, project, env);
  if (leftover !== undefined) {
    return {
      rootDir: leftover,
      repo: name,
      reason: `Sous cloned '${name}' into this checkout earlier.`,
      notes: [
        `'${name}' is not linked in this project, so builds read its published versions; ` +
          `the checkout sous cloned for it is still at ${leftover}, and the change is ` +
          `proposed from there.`,
      ],
    };
  }

  throw noWorkingCopy(
    name,
    `It is not linked in this project, and no checkout of it is where 'sous repo link' ` +
      `clones one.`
  );
}

/** The recipe repository around a directory, or undefined when there is none. */
function recipeRepoAround(cwd: string): string | undefined {
  try {
    return findRepoRoot(cwd);
  } catch {
    return undefined;
  }
}

/**
 * With no argument inside a project: the one linked repository, or a choice
 * between several.
 */
async function chooseLinked(
  project: SubmitProject,
  env: NodeJS.ProcessEnv,
  options: FindSubmitCheckoutOptions
): Promise<SubmitCheckout> {
  const links = readEffectiveLinks(project.sousDir, env);
  const names = Object.keys(links).sort();

  if (names.length === 0) {
    throw new ConfigError(
      "This project links no repository, so there is no working copy to propose from.\n" +
        "  Link one with 'sous repo link <repo>', make your change in its checkout, then run " +
        "'sous repo submit <repo>'."
    );
  }

  let name: string;
  let reason: string;
  if (names.length === 1) {
    name = names[0]!;
    reason = `It is the only repository this project links.`;
  } else {
    if (!options.interactive) {
      throw nonInteractiveError({
        prompt: "which linked repository to propose a change from",
        remedy: `name it as the argument, as in 'sous repo submit ${names[0]}'.`,
        details: [`This project links ${names.join(", ")}.`],
      });
    }
    const choose =
      options.choose ??
      ((message: string, offered: string[]) =>
        askChoice(
          message,
          offered.map((entry) => ({ name: `${entry}  ${links[entry]!.path}`, value: entry }))
        ));
    name = await choose("Which linked repository should the change be proposed from?", names);
    reason = "You chose it.";
  }

  const link = links[name]!;
  if (!fs.existsSync(link.path)) {
    throw noWorkingCopy(name, `Its link points at ${link.path}, which does not exist.`);
  }
  return { rootDir: link.path, repo: name, reason, notes: [] };
}

/**
 * The repositories a reference may name here: every one the project uses, and
 * any linked name the config does not list, so a link is never unreachable.
 */
function referenceRepos(
  project: SubmitProject,
  links: Record<string, { path: string }>
): CatalogRepo[] {
  const known = (name: string, url: string): CatalogRepo => {
    const location = locationFromUrl(url);
    return { name, ...(location === undefined ? {} : { location }), namespaces: [], recipes: [] };
  };
  const repos: CatalogRepo[] = Object.entries(project.repos).map(([name, entry]) =>
    known(name, entry.url)
  );
  for (const name of Object.keys(links).sort()) {
    if (project.repos[name] === undefined) repos.push(known(name, links[name]!.path));
  }
  return repos;
}

/**
 * A checkout sous cloned for a repository that is no longer linked: the
 * project's own clone first, then the machine-wide one, each only when it is a
 * checkout of that same repository.
 */
function leftoverCheckout(
  name: string,
  project: SubmitProject,
  env: NodeJS.ProcessEnv
): string | undefined {
  const url = project.repos[name]?.url;
  if (url === undefined) return undefined;

  let slug: { owner: string; name: string };
  try {
    slug = repoSlugFromUrl(url);
  } catch {
    return undefined;
  }

  for (const base of [projectReposDir(project.sousDir), globalReposDir(env)]) {
    const directory = path.join(base, slug.owner, slug.name);
    if (!isGitCheckout(directory)) continue;
    const remote = remoteUrlOf(directory);
    if (remote !== undefined && sameRemote(remote, url)) return directory;
  }
  return undefined;
}

/** The error for a repository with no working copy to propose from. */
function noWorkingCopy(name: string, why: string): ConfigError {
  return new ConfigError(
    `There is no working copy of '${name}' to propose a change from.\n` +
      `  ${why}\n` +
      `  Link it with 'sous repo link ${name}', make your change in its checkout, then run ` +
      `the command again.`
  );
}
