/**
 * The ref parser: the one place a written ref becomes the things it could mean.
 *
 * A "ref" is how everything in the Repositories system names a namespace or a
 * recipe: on the command line, in a project's subscriptions, in a recipe
 * manifest's `depends` and `subscribes` lists, and in the keys sous stores. One
 * function reads all of them, and is told where the ref came from:
 *
 *     parseRef(ref, from = RefSource.CommandLine)
 *
 * It recognizes every form a person might write:
 *
 *     workflow                                          a namespace
 *     workflow/alpha                                    a recipe
 *     workflow/*                                        a namespace, spelled out
 *     sous-recipes:workflow/alpha                       a recipe in a named repository
 *     workflow/alpha@^1.2.0                             any of these with a version range
 *     github://owner/repo/workflow                      a namespace, by location
 *     github://owner/repo/workflow/*                    the same, spelled out
 *     github://owner/repo/workflow/alpha                a recipe, by location
 *     https://github.com/owner/repo/workflow/alpha      an HTTPS URL
 *     github.com/owner/repo/workflow/alpha              a URL with no scheme
 *     git@github.com:owner/repo.git                     an SSH remote
 *     https://github.com/owner/repo/tree/main/recipes/workflow/alpha
 *                                                       a browser URL from the file view
 *     https://gitlab.com/group/sub/project/-/tree/main/recipes/workflow/alpha
 *                                                       GitLab, nested groups included
 *
 * and returns EVERY reading of it, because some forms can be read more than one
 * way: a GitLab URL with nested groups does not say where the project path
 * ends, and a browser URL names a folder whose recipe only the repository's
 * index can say. Whoever holds the index settles them (`settle.ts`).
 *
 * The place (`from`) decides which forms are allowed; a refused form is an
 * error saying what to write there instead. Nothing host-specific lives here:
 * where a repository path ends and what a browser path looks like are each
 * provider's own rule, asked through `RepoProvider.readLocation`.
 */

import semver from "semver";
import { ConfigError } from "../errors.js";
import { repoIdentity } from "../repos/identity.js";
import {
  builtInProviders,
  detectProvider,
  providerById,
  type ProviderId,
  type RepoProvider,
} from "../repos/providers/index.js";
import { RefSource } from "./scopes.js";

// --- What a reading is ----------------------------------------------------------------------------

/** Where a located ref says its repository lives. */
export type RefLocation = {
  /** The provider that reads the location. */
  provider: ProviderId;
  /** The host, such as `github.com`. */
  host: string;
  /** The repository's path on the host, such as `sous-io/sous-recipes`. */
  repoPath: string;
  /** The repository's canonical identity, as the store and the lockfile key it. */
  identity: string;
  /** The repository's HTTPS URL, which is what adding it is handed. */
  url: string;
};

/**
 * A reading that names a namespace or a recipe. `recipe` is absent for a
 * namespace; `range` needs a recipe.
 */
export type ParsedRef = {
  /** The repository short name from a `repo:` qualifier, when one was given. */
  repo?: string;
  /** Where the repository lives, when the ref named it by location. */
  location?: RefLocation;
  /** The namespace. */
  namespace: string;
  /** The recipe name, when the ref names a recipe rather than a whole namespace. */
  recipe?: string;
  /** The semantic version range, when one was given. Only legal with a recipe. */
  range?: string;
};

/**
 * A reading that names a folder in a repository, copied from a host's file
 * view. Which recipe or namespace that is only the repository's index can say,
 * through the `path` each recipe's entry records.
 */
export type BrowsedRef = {
  /** Where the repository lives. */
  location: RefLocation;
  /** The path after `tree/` or `blob/`, with the branch still in front of it. */
  browsed: string;
  /** The version range, when one was given. */
  range?: string;
};

/** A reading that names a whole repository and nothing inside it. */
export type RepositoryRef = {
  /** Where the repository lives. */
  location: RefLocation;
  /** Always true; tells this reading apart from the others. */
  repository: true;
};

/** One thing a written ref could mean. */
export type RefReading = ParsedRef | BrowsedRef | RepositoryRef;

/** True when a reading names a namespace or a recipe. */
export function isNamedReading(reading: RefReading): reading is ParsedRef {
  return "namespace" in reading;
}

/** True when a reading names a browser path still to be settled. */
export function isBrowsedReading(reading: RefReading): reading is BrowsedRef {
  return "browsed" in reading;
}

/** True when a reading names a whole repository. */
export function isRepositoryReading(reading: RefReading): reading is RepositoryRef {
  return "repository" in reading;
}

// --- The parser -----------------------------------------------------------------------------------

/** What each place is called in a sentence. */
const PLACE_LABELS: Record<RefSource, string> = {
  [RefSource.CommandLine]: "on the command line",
  [RefSource.Config]: "as a subscription key in a config file",
  [RefSource.Manifest]: "in a recipe manifest's 'depends' or 'subscribes' list",
  [RefSource.Lockfile]: "as a key sous stores",
};

/** The forms each place allows, for the reminder under a ref that does not parse. */
const SYNTAX_HELP: Record<RefSource, string> = {
  [RefSource.CommandLine]:
    "A ref is written as 'namespace', 'namespace/recipe', 'repo:namespace/recipe', " +
    "any of those with '@<range>', or a location such as " +
    "'github://owner/repository/namespace/recipe' or a URL copied from the browser.",
  [RefSource.Config]:
    "A subscription key is written as 'namespace' or 'namespace/recipe'.",
  [RefSource.Manifest]:
    "A dependency is written either as a bare ref naming a recipe in this same repository " +
    "('workflow/task-files', optionally with a range such as 'workflow/task-files@^1.1'), " +
    "or by location for one in another repository " +
    "('github://sous-io/sous-recipes/workflow/task-files@^1.1', an HTTPS or SSH URL, or a " +
    "URL copied from the browser).",
  [RefSource.Lockfile]: "A stored key is written as 'namespace' or 'namespace/recipe'.",
};

/** A name as the parser accepts it: kebab-case, in any case. */
const NAME_ANY_CASE = /^[a-z][a-z0-9-]*$/i;

/** A name as it is stored: lowercase kebab-case. */
const NAME_STORED = /^[a-z][a-z0-9-]*$/;

/** A URL that names its scheme, such as `https://` or `github://`. */
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;

/** The `scp`-style SSH form, as in `git@github.com:owner/name.git`. */
const SCP_PATTERN = /^[^@\s/:]+@([^@\s/:]+):(.+)$/s;

/** Schemes that are ordinary URLs rather than a provider's own identifier. */
const URL_SCHEMES = new Set(["http", "https", "ssh", "git", "git+ssh", "ssh+git"]);

/** Schemes that name a repository on this machine. */
const LOCAL_SCHEMES = new Set(["local", "file"]);

/** The reason one reading of a location was left out, kept for the error. */
type Dropped = { reason: string };

/**
 * Every reading of a written ref, allowed where it was written.
 *
 * parseRef("workflow/alpha@^1.2");
 * // -> [{ namespace: "workflow", recipe: "alpha", range: "^1.2" }]
 *
 * parseRef("https://gitlab.com/a/b/c/d", RefSource.Manifest);
 * // -> [{ location: gitlab.com/a/b, namespace: "c", recipe: "d" },
 * //     { location: gitlab.com/a/b/c, namespace: "d" }]
 *
 * @param input - The ref exactly as it was written.
 * @param from - Where it was written, which decides the forms allowed.
 * @param providers - The providers that read locations. Defaults to the built-ins.
 * @returns Every reading, never empty. A ref that fits no form, or a form the
 *   place refuses, raises a ConfigError instead.
 */
export function parseRef(
  input: string,
  from: RefSource = RefSource.CommandLine,
  providers: RepoProvider[] = builtInProviders()
): RefReading[] {
  if (typeof input !== "string") {
    throw refError(String(input), from, "a ref must be a string.");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) throw refError(input, from, "a ref must not be empty.");

  if (trimmed.startsWith("@")) {
    throw refError(
      input,
      from,
      "refs take no '@' prefix. The '@' character introduces a version range only, " +
        "as in 'workflow/task-files@^1.2.0'."
    );
  }
  if (trimmed.startsWith("~")) {
    throw refError(
      input,
      from,
      "refs take no '~' prefix. The '~' sigil belongs to template include lines " +
        "('@~workflow/file.md'); a ref itself is written without it."
    );
  }

  const readings = looksLikeLocation(trimmed)
    ? readLocated(input, trimmed, from, providers)
    : [readShort(input, trimmed, from)];

  return readings.map((reading) => storedCase(reading, from));
}

/**
 * True when a written ref names a location (a URL, an SSH remote, a
 * provider-scheme locator or a host path) rather than a short name. A short
 * name never carries `://`, an `@` before a `:`, or a dot in its first segment.
 *
 * @param ref - The ref as written.
 */
export function looksLikeLocation(ref: string): boolean {
  const trimmed = ref.trim();
  if (SCHEME_PATTERN.test(trimmed)) return true;
  if (SCP_PATTERN.test(trimmed)) return true;
  const first = trimmed.split("/")[0] ?? "";
  return trimmed.includes("/") && first.includes(".") && !first.includes(":");
}

/**
 * The one reading of a ref that must name a namespace or a recipe by its short
 * form: a config key, a stored key, or a ref a caller has already settled.
 *
 * @param input - The ref as written.
 * @param from - Where it was written.
 */
export function parseShortRef(input: string, from: RefSource = RefSource.CommandLine): ParsedRef {
  const readings = parseRef(input, from);
  const only = readings[0]!;
  if (readings.length === 1 && isNamedReading(only) && only.location === undefined) return only;
  throw refError(
    input,
    from,
    "this needs a namespace or a recipe named by its short form, such as 'workflow/alpha', " +
      "and this ref names a location."
  );
}

/**
 * The namespace and name of a stored recipe key, `namespace/recipe`.
 *
 * splitRecipeKey("workflow/alpha"); // -> { namespace: "workflow", name: "alpha" }
 *
 * @param key - A key sous stored.
 */
export function splitRecipeKey(key: string): { namespace: string; name: string } {
  const parsed = parseShortRef(key, RefSource.Lockfile);
  if (parsed.recipe === undefined) {
    throw refError(key, RefSource.Lockfile, "a recipe key names a namespace and a recipe.");
  }
  return { namespace: parsed.namespace, name: parsed.recipe };
}

/**
 * The namespace a stored key belongs to: the key itself for a namespace, and
 * its namespace for a recipe.
 *
 * namespaceOfKey("workflow/alpha"); // -> "workflow"
 *
 * @param key - A key sous stored.
 */
export function namespaceOfKey(key: string): string {
  return parseShortRef(key, RefSource.Lockfile).namespace;
}

// --- Formatting -----------------------------------------------------------------------------------

/**
 * The ref's identity, with the repository and the version range dropped:
 * `namespace` for a namespace, `namespace/recipe` for a recipe. It is the key
 * everything is stored under (subscriptions, the index, the lockfile), so the
 * same recipe is never recorded twice under two spellings.
 *
 * @param parsed - The reading.
 */
export function refKey(parsed: ParsedRef): string {
  return parsed.recipe === undefined ? parsed.namespace : `${parsed.namespace}/${parsed.recipe}`;
}

/** True when the reading names a whole namespace rather than a single recipe. */
export function isNamespaceRef(parsed: ParsedRef): boolean {
  return parsed.recipe === undefined;
}

/**
 * The canonical written form of a reading, which is how sous prints it: the
 * short form for a short ref, and each provider's own canonical locator for a
 * located one.
 *
 * formatRef({ repo: "sous-recipes", namespace: "workflow", recipe: "alpha" });
 * // -> "sous-recipes:workflow/alpha"
 *
 * @param reading - The reading.
 * @param providers - The providers that format locators. Defaults to the built-ins.
 */
export function formatRef(
  reading: RefReading,
  providers: RepoProvider[] = builtInProviders()
): string {
  const range = "range" in reading && reading.range !== undefined ? `@${reading.range}` : "";

  if (reading.location === undefined) {
    const named = reading as ParsedRef;
    const qualifier = named.repo === undefined ? "" : `${named.repo}:`;
    return `${qualifier}${refKey(named)}${range}`;
  }

  const { host, repoPath } = reading.location;
  const provider = providerById(reading.location.provider, providers);
  const rest = isNamedReading(reading)
    ? refKey(reading)
    : isBrowsedReading(reading)
      ? `tree/${reading.browsed}`
      : "";
  /* c8 ignore next 2 */
  if (provider === undefined) return `${reading.location.url}/${rest}${range}`;
  return `${provider.formatLocator(host, repoPath, rest)}${range}`;
}

// --- Short refs -----------------------------------------------------------------------------------

/**
 * Reads `[repo:]namespace[/recipe|/*][@range]`.
 *
 * @param input - The ref as written, for messages.
 * @param trimmed - The ref, trimmed.
 * @param from - Where it was written.
 */
function readShort(input: string, trimmed: string, from: RefSource): ParsedRef {
  let body = trimmed;
  let range: string | undefined;
  const atIndex = body.indexOf("@");
  if (atIndex !== -1) {
    if (body.indexOf("@", atIndex + 1) !== -1) {
      throw refError(input, from, "a ref may carry at most one '@' version range.");
    }
    range = body.slice(atIndex + 1).trim();
    body = body.slice(0, atIndex).trim();
    if (range.length === 0) {
      throw refError(input, from, "the '@' is not followed by a version range.");
    }
  }

  let repo: string | undefined;
  const colonIndex = body.indexOf(":");
  if (colonIndex !== -1) {
    if (body.indexOf(":", colonIndex + 1) !== -1) {
      throw refError(input, from, "a ref may carry at most one 'repo:' qualifier.");
    }
    repo = body.slice(0, colonIndex);
    body = body.slice(colonIndex + 1);
    if (repo.length === 0) {
      throw refError(input, from, "the repo qualifier before ':' is empty.");
    }
    if (!NAME_ANY_CASE.test(repo)) {
      throw refError(
        input,
        from,
        `the repo qualifier '${repo}' must be kebab-case: a letter, then letters, digits ` +
          "or hyphens."
      );
    }
  }

  const segments = body.split("/");
  let wildcard = false;
  if (segments.length === 2 && segments[1] === "*") {
    segments.pop();
    wildcard = true;
  }
  if (segments.length > 2) {
    throw refError(
      input,
      from,
      "a short ref has at most two path segments, a namespace and a recipe. A folder path " +
        "inside a repository is written as a URL copied from the browser instead."
    );
  }

  const [namespace, recipe] = segments;
  if (namespace === undefined || namespace.length === 0) {
    throw refError(input, from, "the namespace is empty.");
  }
  checkName(input, from, "namespace", namespace);
  if (recipe !== undefined) {
    if (recipe.length === 0) throw refError(input, from, "the recipe name after '/' is empty.");
    checkName(input, from, "recipe name", recipe);
  }
  if (range !== undefined) checkRange(input, from, range, recipe !== undefined);

  const parsed: ParsedRef = { namespace };
  if (repo !== undefined) parsed.repo = repo;
  if (recipe !== undefined) parsed.recipe = recipe;
  if (range !== undefined) parsed.range = range;

  refuseShortForms(input, from, parsed, wildcard);
  return parsed;
}

/**
 * Refuses the short forms a place does not allow, saying what to write
 * instead.
 *
 * @param input - The ref as written.
 * @param from - Where it was written.
 * @param parsed - What it reads as.
 * @param wildcard - Whether a namespace was spelled `namespace/*`.
 */
function refuseShortForms(
  input: string,
  from: RefSource,
  parsed: ParsedRef,
  wildcard: boolean
): void {
  const key = refKey(parsed).toLowerCase();

  if (parsed.repo !== undefined && from !== RefSource.CommandLine) {
    if (from === RefSource.Manifest) {
      throw refused(
        input,
        from,
        "a 'repo:' qualifier names a short name that only the consuming project knows, so " +
          "it cannot appear in a published manifest.",
        `'${key}' for a recipe in this same repository, or name the other repository by ` +
          `its location, as in 'github://owner/repository/${key}'`
      );
    }
    throw refused(
      input,
      from,
      from === RefSource.Config
        ? "the repository a subscription resolves into is recorded in the lockfile, not in " +
            "the key. To choose between repositories, run " +
            `'sous subscribe ${parsed.repo}:${key}', which records the choice.`
        : "a stored key never names a repository.",
      `'${key}'`
    );
  }

  if (from === RefSource.Config || from === RefSource.Lockfile) {
    if (parsed.range !== undefined) {
      throw refused(
        input,
        from,
        from === RefSource.Config
          ? "a subscription's version range belongs in the entry's own 'range' field."
          : "a stored key carries no version range.",
        from === RefSource.Config ? `'${key}': { range: '${parsed.range}' }` : `'${key}'`
      );
    }
    if (wildcard) {
      throw refused(input, from, "a whole namespace is stored as its name alone.", `'${key}'`);
    }
    if (!NAME_STORED.test(parsed.namespace) || (parsed.recipe !== undefined && !NAME_STORED.test(parsed.recipe))) {
      throw refused(input, from, "stored names are lowercase.", `'${key}'`);
    }
  }
}

// --- Located refs ---------------------------------------------------------------------------------

/**
 * Reads a ref that names a location: a provider-scheme locator, an ordinary
 * URL, an SSH remote or a host path, each optionally followed by `@<range>`.
 *
 * @param input - The ref as written, for messages.
 * @param trimmed - The ref, trimmed.
 * @param from - Where it was written.
 * @param providers - The providers that read locations.
 */
function readLocated(
  input: string,
  trimmed: string,
  from: RefSource,
  providers: RepoProvider[]
): RefReading[] {
  if (from === RefSource.Config) {
    throw refused(
      input,
      from,
      "a config file names a subscription by its short form; the repository it lives in is " +
        "a separate entry under 'repos'.",
      `'namespace/recipe', or run 'sous subscribe ${trimmed}', which adds the repository ` +
        "and writes the subscription in its short form"
    );
  }
  if (from === RefSource.Lockfile) {
    throw refused(input, from, "a stored key never names a location.", "'namespace/recipe'");
  }

  // The range is whatever follows the last '@' after the last '/', so the '@'
  // of an SSH remote ('git@host:...') is never mistaken for one.
  let body = trimmed;
  let range: string | undefined;
  const at = body.lastIndexOf("@");
  if (at !== -1 && at > body.lastIndexOf("/")) {
    range = body.slice(at + 1).trim();
    body = body.slice(0, at).trim();
    if (range.length === 0) {
      throw refError(input, from, "the '@' is not followed by a version range.");
    }
    checkRange(input, from, range, true);
  }

  const { provider, host, segments } = splitLocation(input, body, from, providers);
  const locationReadings = provider.readLocation({ host, segments });

  const readings: RefReading[] = [];
  const dropped: Dropped[] = [];

  for (const read of locationReadings) {
    const location = locationOf(provider, host, read.repoPath);
    if (location === undefined) continue;

    if (read.browsed !== undefined) {
      const browsed = read.browsed.replace(/^\/+|\/+$/g, "");
      if (browsed.length === 0) continue;
      readings.push({ location, browsed, ...(range === undefined ? {} : { range }) });
      continue;
    }

    const named = read.named ?? [];
    if (named.length === 0) {
      if (range === undefined) readings.push({ location, repository: true });
      else dropped.push({ reason: "a version range applies to a recipe, not to a repository." });
      continue;
    }

    const reading = namedReading(location, named, range);
    if ("reason" in reading) dropped.push(reading);
    else readings.push(reading);
  }

  if (readings.length === 0) {
    throw refError(
      input,
      from,
      dropped[0]?.reason ??
        `the ${provider.id} provider cannot read a namespace or a recipe from this location. ` +
          `After the repository, a location names a namespace and optionally a recipe, as in ` +
          `'${provider.formatLocator(host, "owner/repository", "workflow/alpha")}'.`
    );
  }

  // A reading of the whole repository is only kept when nothing more specific
  // was read, because a namespace or a recipe is what a ref is for.
  const specific = readings.filter((reading) => !isRepositoryReading(reading));
  if (specific.length > 0) return specific;

  // A dependency is a namespace or a recipe; a whole repository is not one.
  if (from === RefSource.Manifest) {
    const where = readings[0]!.location!;
    throw refused(
      input,
      from,
      `it names the repository at ${where.url} and nothing inside it, and a dependency is a ` +
        "namespace or a recipe.",
      `'${provider.formatLocator(where.host, where.repoPath, "namespace/recipe")}'`
    );
  }
  return readings;
}

/**
 * Takes the host-agnostic parts out of a location: which provider reads it,
 * the host, and the path segments after the host.
 *
 * @param input - The ref as written, for messages.
 * @param body - The location, without its range.
 * @param from - Where it was written.
 * @param providers - The providers to choose from.
 */
function splitLocation(
  input: string,
  body: string,
  from: RefSource,
  providers: RepoProvider[]
): { provider: RepoProvider; host: string; segments: string[] } {
  const known = providers
    .filter((provider) => provider.defaultHost !== undefined)
    .map((provider) => provider.id)
    .sort()
    .join(", ");

  const scheme = SCHEME_PATTERN.exec(body);
  if (scheme !== null) {
    const name = scheme[1]!.toLowerCase();

    if (LOCAL_SCHEMES.has(name)) {
      throw refused(
        input,
        from,
        from === RefSource.Manifest
          ? "a local repository is a consumer's convenience, not a published location, so a " +
              "manifest cannot depend on one."
          : "a repository on this machine is added by its path, and its recipes are then " +
              "named by their short form.",
        from === RefSource.Manifest
          ? "the recipe's published location, such as 'github://owner/repository/namespace/recipe'"
          : "'sous repo add <path>', then 'namespace/recipe'"
      );
    }

    if (URL_SCHEMES.has(name)) {
      let url: URL;
      try {
        url = new URL(body);
      } catch {
        throw refError(input, from, "the URL could not be read.");
      }
      const host = url.host.toLowerCase();
      const segments = pathSegments(url.pathname);
      return { provider: providerForHost(input, from, host, segments, providers), host, segments };
    }

    const provider = providerById(name, providers);
    if (provider === undefined || provider.defaultHost === undefined) {
      throw refError(
        input,
        from,
        `'${name}' is not a provider sous can read a location from. The scheme of a locator ` +
          `is the provider's own identifier; sous ships these: ${known}. An ordinary ` +
          "'https://' URL works too."
      );
    }
    let segments = pathSegments(scheme[2]!);
    let host = provider.defaultHost;
    if (segments[0]?.includes(".") === true) {
      host = segments[0].toLowerCase();
      segments = segments.slice(1);
    }
    return { provider, host, segments };
  }

  const scp = SCP_PATTERN.exec(body);
  if (scp !== null) {
    const host = scp[1]!.toLowerCase();
    const segments = pathSegments(scp[2]!);
    return { provider: providerForHost(input, from, host, segments, providers), host, segments };
  }

  const all = pathSegments(body);
  const host = all[0]!.toLowerCase();
  const segments = all.slice(1);
  return { provider: providerForHost(input, from, host, segments, providers), host, segments };
}

/**
 * The provider that recognizes a host, asked with the repository URL the
 * location would start with.
 */
function providerForHost(
  input: string,
  from: RefSource,
  host: string,
  segments: string[],
  providers: RepoProvider[]
): RepoProvider {
  const probe = `https://${host}/${segments.slice(0, 2).join("/")}`;
  const provider = detectProvider(probe, providers);
  if (provider !== undefined && provider.defaultHost !== undefined) return provider;
  const ids = providers
    .filter((entry) => entry.defaultHost !== undefined)
    .map((entry) => entry.id)
    .sort();
  throw refError(
    input,
    from,
    `sous does not recognize the host '${host}'. For a self-hosted instance, write the ` +
      `location with the provider's scheme and the host, as in ` +
      `'${ids[0] ?? "gitlab"}://${host}/owner/repository/namespace/recipe' (sous ships these ` +
      `providers: ${ids.join(", ")}).`
  );
}

/** A URL path's segments, decoded, with empty ones dropped. */
function pathSegments(pathname: string): string[] {
  return pathname
    .split(/[?#]/)[0]!
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter((segment) => segment.length > 0);
}

/**
 * Where one reading's repository lives, or undefined when the provider cannot
 * take its path apart (a path of one segment, say).
 */
function locationOf(
  provider: RepoProvider,
  host: string,
  repoPath: string
): RefLocation | undefined {
  const url = `https://${host}/${repoPath}`;
  try {
    return {
      provider: provider.id,
      host,
      repoPath,
      identity: repoIdentity(provider.canonicalize(url)),
      url,
    };
  } catch {
    return undefined;
  }
}

/**
 * The reading named by the segments after a repository, or the reason it is
 * not one.
 */
function namedReading(
  location: RefLocation,
  named: string[],
  range: string | undefined
): ParsedRef | Dropped {
  const segments = named.length === 2 && named[1] === "*" ? [named[0]!] : named;
  const where = location.url;

  if (segments.length > 2) {
    return {
      reason:
        `after the repository ${where}, '${segments.join("/")}' is ` +
        `${segments.length} segments, and a location names a namespace and optionally a ` +
        "recipe. A folder path is written as the URL copied from the browser, with its " +
        "'tree/<branch>/' part.",
    };
  }

  const [namespace, recipe] = segments as [string, string | undefined];
  for (const [what, name] of [
    ["namespace", namespace],
    ["recipe name", recipe],
  ] as const) {
    if (name !== undefined && !NAME_ANY_CASE.test(name)) {
      return {
        reason:
          `the ${what} '${name}' must be kebab-case: a letter, then letters, digits or ` +
          "hyphens.",
      };
    }
  }

  if (range !== undefined && recipe === undefined) {
    return {
      reason:
        "a version range applies to a recipe, and namespaces are not versioned. Name a " +
        "recipe, as in 'github://owner/repository/workflow/task-files@^1.2.0'.",
    };
  }

  return {
    location,
    namespace,
    ...(recipe === undefined ? {} : { recipe }),
    ...(range === undefined ? {} : { range }),
  };
}

// --- Shared pieces --------------------------------------------------------------------------------

/**
 * A reading with its names in the case a place stores. A manifest is published
 * and every published name is lowercase, so a manifest's names are lowercased;
 * the command line keeps what was typed, and matching settles it (exact first,
 * then ignoring case).
 */
function storedCase(reading: RefReading, from: RefSource): RefReading {
  if (from !== RefSource.Manifest || !isNamedReading(reading)) return reading;
  return {
    ...reading,
    namespace: reading.namespace.toLowerCase(),
    ...(reading.recipe === undefined ? {} : { recipe: reading.recipe.toLowerCase() }),
  };
}

/** Checks one name, which may be written in any case. */
function checkName(input: string, from: RefSource, what: string, name: string): void {
  if (NAME_ANY_CASE.test(name)) return;
  throw refError(
    input,
    from,
    `the ${what} '${name}' must be kebab-case: a letter, then letters, digits or hyphens.`
  );
}

/** Checks a version range, and that there is a recipe for it to apply to. */
function checkRange(input: string, from: RefSource, range: string, hasRecipe: boolean): void {
  if (!hasRecipe) {
    throw refError(
      input,
      from,
      "a version range applies to a recipe, and namespaces are not versioned. Name a " +
        "recipe, as in 'workflow/task-files@^1.2.0'."
    );
  }
  if (semver.validRange(range) === null) {
    throw refError(
      input,
      from,
      `'${range}' is not a version range. Ranges follow npm's rules, such as '^1.2.0', ` +
        "'~2.1', '>=1.0.0 <2.0.0' or '*'."
    );
  }
}

/** A ConfigError for a ref that fits no form, quoting it and showing the forms allowed there. */
function refError(input: string, from: RefSource, problem: string): ConfigError {
  return new ConfigError(`Invalid ref '${input}': ${problem}\n  ${SYNTAX_HELP[from]}`);
}

/** A ConfigError for a form this place does not allow, saying what to write instead. */
function refused(input: string, from: RefSource, reason: string, instead: string): ConfigError {
  return new ConfigError(
    `The ref '${input.trim()}' cannot be written ${PLACE_LABELS[from]}: ${reason}\n` +
      `  Write ${instead} instead.`
  );
}
