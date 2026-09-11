/**
 * The ref parser.
 *
 * A "ref" is how everything in the Repositories system names a namespace or a
 * recipe: on the command line, in a project's subscriptions, and in a recipe
 * manifest's `depends` and `subscribes` lists. The grammar is deliberately
 * small and prefix-free:
 *
 *     ref := [ repo ":" ] namespace [ "/" recipe [ "@" range ] ]
 *
 *     workflow                              a whole namespace
 *     workflow/task-files                   one recipe, any version
 *     workflow/task-files@^1.2.0            one recipe, constrained
 *     sous-recipes:workflow/task-files      the same recipe in a named repo
 *
 * The repo qualifier is only needed when the same ref resolves in more than one
 * added repo; refs otherwise resolve across every added repo's cached index.
 * A version range applies to a recipe, never to a namespace, because namespaces
 * are not versioned.
 */

import semver from "semver";
import { ConfigError } from "../errors.js";
import {
  NAMESPACE_NAME_PATTERN,
  RECIPE_NAME_PATTERN,
  REPO_NAME_PATTERN,
} from "./formats/patterns.js";

/** A parsed ref. `recipe` is absent for a namespace ref; `range` needs a recipe. */
export type ParsedRef = {
  /** The repo short name from a `repo:` qualifier, when one was given. */
  repo?: string;
  /** The namespace. Always present. */
  namespace: string;
  /** The recipe name, when the ref names a recipe rather than a whole namespace. */
  recipe?: string;
  /** The semantic version range, when one was given. Only legal with a recipe. */
  range?: string;
};

/** The one-line reminder appended to every ref error. */
const SYNTAX_HELP =
  "A ref is written as 'namespace', 'namespace/recipe', 'namespace/recipe@<range>' or " +
  "'repo:namespace/recipe@<range>'.";

/** Builds a ConfigError that quotes the offending input and shows the grammar. */
function refError(input: string, problem: string): ConfigError {
  return new ConfigError(`Invalid ref '${input}': ${problem}\n  ${SYNTAX_HELP}`);
}

/**
 * Parses a ref string into its parts, throwing a ConfigError that quotes the
 * input and shows the grammar when it does not fit.
 *
 * @param input - The ref as written by a user or a manifest.
 */
export function parseRef(input: string): ParsedRef {
  if (typeof input !== "string") {
    throw refError(String(input), "a ref must be a string.");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw refError(input, "a ref must not be empty.");
  }

  if (trimmed.startsWith("@")) {
    throw refError(
      input,
      "refs take no '@' prefix. The '@' character introduces a version range only, " +
        "as in 'workflow/task-files@^1.2.0'."
    );
  }
  if (trimmed.startsWith("~")) {
    throw refError(
      input,
      "refs take no '~' prefix. The '~' sigil belongs to template include lines " +
        "('@~workflow/file.md'); a ref itself is written without it."
    );
  }

  // Split the version range off first, so the rest is pure path and qualifier.
  let body = trimmed;
  let range: string | undefined;
  const atIndex = body.indexOf("@");
  if (atIndex !== -1) {
    if (body.indexOf("@", atIndex + 1) !== -1) {
      throw refError(input, "a ref may carry at most one '@' version range.");
    }
    range = body.slice(atIndex + 1).trim();
    body = body.slice(0, atIndex);
    if (range.length === 0) {
      throw refError(input, "the '@' is not followed by a version range.");
    }
  }

  // Then the repo qualifier.
  let repo: string | undefined;
  const colonIndex = body.indexOf(":");
  if (colonIndex !== -1) {
    if (body.indexOf(":", colonIndex + 1) !== -1) {
      throw refError(input, "a ref may carry at most one 'repo:' qualifier.");
    }
    repo = body.slice(0, colonIndex);
    body = body.slice(colonIndex + 1);
    if (repo.length === 0) {
      throw refError(input, "the repo qualifier before ':' is empty.");
    }
    if (!REPO_NAME_PATTERN.test(repo)) {
      throw refError(
        input,
        `the repo qualifier '${repo}' must be lowercase kebab-case: a letter, then ` +
          "letters, digits or hyphens."
      );
    }
  }

  // What is left is the namespace, optionally followed by a recipe.
  const segments = body.split("/");
  if (segments.length > 2) {
    throw refError(
      input,
      "a ref has at most two path segments, a namespace and a recipe."
    );
  }

  const [namespace, recipe] = segments;
  if (namespace === undefined || namespace.length === 0) {
    throw refError(input, "the namespace is empty.");
  }
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw refError(
      input,
      `the namespace '${namespace}' must be lowercase kebab-case: a letter, then ` +
        "letters, digits or hyphens."
    );
  }

  if (recipe !== undefined) {
    if (recipe.length === 0) {
      throw refError(input, "the recipe name after '/' is empty.");
    }
    if (!RECIPE_NAME_PATTERN.test(recipe)) {
      throw refError(
        input,
        `the recipe name '${recipe}' must be lowercase kebab-case: a letter, then ` +
          "letters, digits or hyphens."
      );
    }
  }

  if (range !== undefined) {
    if (recipe === undefined) {
      throw refError(
        input,
        "a version range applies to a recipe, and namespaces are not versioned. " +
          "Name a recipe, as in 'workflow/task-files@^1.2.0'."
      );
    }
    if (semver.validRange(range) === null) {
      throw refError(
        input,
        `'${range}' is not a version range. Ranges follow npm's rules, such as ` +
          "'^1.2.0', '~2.1', '>=1.0.0 <2.0.0' or '*'."
      );
    }
  }

  const parsed: ParsedRef = { namespace };
  if (repo !== undefined) parsed.repo = repo;
  if (recipe !== undefined) parsed.recipe = recipe;
  if (range !== undefined) parsed.range = range;
  return parsed;
}

/**
 * Parses a ref, returning undefined instead of throwing. Use this where a bad
 * ref is reported through another mechanism, such as a zod issue.
 *
 * @param input - The ref as written.
 */
export function tryParseRef(input: string): ParsedRef | undefined {
  try {
    return parseRef(input);
  } catch {
    return undefined;
  }
}

/**
 * True when the input parses as a ref.
 *
 * @param input - The ref as written.
 */
export function isValidRef(input: string): boolean {
  return tryParseRef(input) !== undefined;
}

/**
 * Renders a parsed ref back into its canonical written form. Round-trips with
 * parseRef, apart from surrounding whitespace.
 *
 * @param parsed - The ref parts.
 */
export function formatRef(parsed: ParsedRef): string {
  const qualifier = parsed.repo === undefined ? "" : `${parsed.repo}:`;
  const recipe = parsed.recipe === undefined ? "" : `/${parsed.recipe}`;
  const range = parsed.range === undefined ? "" : `@${parsed.range}`;
  return `${qualifier}${parsed.namespace}${recipe}${range}`;
}

/**
 * The ref's identity, with the repo qualifier and the version range dropped:
 * `namespace` for a namespace ref, `namespace/recipe` for a recipe ref. This is
 * the key everything else is stored under (subscriptions, the index, the
 * lockfile), so the same recipe is never recorded twice under two spellings.
 *
 * @param parsed - The ref parts.
 */
export function refKey(parsed: ParsedRef): string {
  return parsed.recipe === undefined
    ? parsed.namespace
    : `${parsed.namespace}/${parsed.recipe}`;
}

/** True when the ref names a whole namespace rather than a single recipe. */
export function isNamespaceRef(parsed: ParsedRef): boolean {
  return parsed.recipe === undefined;
}

// --- Dependency refs ----------------------------------------------------------------------------

/**
 * The default host of each provider that can appear as a dependency locator's
 * scheme. A locator whose repository path does not begin with a host segment
 * (a segment carrying a dot) means the provider's own public host.
 *
 * The values match the `GITHUB_HOST` and `GITLAB_HOST` constants the providers
 * themselves use; they are repeated here because the ref parser deliberately
 * imports nothing from the provider layer, which is built on top of it.
 */
export const DEPENDENCY_PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
};

/**
 * A dependency as a recipe manifest writes it, in either of the two spellings
 * `depends` and `subscribes` accept.
 *
 * A SIBLING is a recipe in the same repository, written as a bare ref; a REMOTE
 * is a recipe in another repository, written as a locator URL whose scheme is
 * the provider's identifier.
 */
export type DependencyRef = {
  /** Whether the target lives in this repository or in another one. */
  kind: "sibling" | "remote";
  /** The provider identifier the locator's scheme named. Remote refs only. */
  provider?: string;
  /** The host the repository lives on, explicit or the provider's default. */
  host?: string;
  /** The repository's path on that host, such as `sous-io/sous-recipes`. */
  repoPath?: string;
  /** The repository's canonical identity, `<host>/<repoPath>`. Remote refs only. */
  canonicalRepo?: string;
  /** The namespace the target recipe belongs to. */
  namespace: string;
  /**
   * The recipe's name. A sibling ref may name a whole namespace and leave this
   * out; a locator URL always names a recipe, because its last two path
   * segments are by rule the namespace and the recipe.
   */
  recipe?: string;
  /** The version range, when one was written. */
  range?: string;
};

/** The one-line reminder appended to every dependency ref error. */
const DEPENDENCY_SYNTAX_HELP =
  "A dependency is written either as a bare ref naming a recipe in this same repository " +
  "('workflow/task-files', optionally with a range such as 'workflow/task-files@^1.1'), " +
  "or as a locator URL naming a recipe in another repository " +
  "('github://sous-io/sous-recipes/workflow/task-files@^1.1').";

/** Builds a ConfigError that quotes the offending dependency and shows the grammar. */
function dependencyError(input: string, problem: string): ConfigError {
  return new ConfigError(
    `Invalid dependency '${input}': ${problem}\n  ${DEPENDENCY_SYNTAX_HELP}`
  );
}

/** The scheme a locator URL leads with, when it leads with one. */
const LOCATOR_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;

/**
 * Parses one entry of a recipe manifest's `depends` or `subscribes` list.
 *
 * parseDependencyRef("workflow/task-files");
 * // -> { kind: "sibling", namespace: "workflow", recipe: "task-files" }
 *
 * parseDependencyRef("github://sous-io/sous-recipes/workflow/sat@^1.1");
 * // -> { kind: "remote", provider: "github", host: "github.com",
 * //      repoPath: "sous-io/sous-recipes",
 * //      canonicalRepo: "github.com/sous-io/sous-recipes",
 * //      namespace: "workflow", recipe: "sat", range: "^1.1" }
 *
 * @param input - The dependency exactly as the manifest wrote it.
 */
export function parseDependencyRef(input: string): DependencyRef {
  if (typeof input !== "string") {
    throw dependencyError(String(input), "a dependency must be a string.");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw dependencyError(input, "a dependency must not be empty.");
  }

  const locator = LOCATOR_SCHEME_PATTERN.exec(trimmed);
  if (locator !== null) return parseRemoteDependency(input, locator[1]!, locator[2]!);

  // Anything without a scheme is a sibling, so it follows the ordinary ref
  // grammar; the one thing a manifest may no longer write is the consumer-side
  // 'repo:' qualifier, which names a short name only that project knows.
  if (trimmed.includes(":")) {
    throw dependencyError(
      input,
      "a 'repo:' qualifier names a short name that only the consuming project knows, so " +
        "it cannot appear in a published manifest. Name the other repository by its " +
        "location instead, as in 'github://owner/repository/namespace/recipe'."
    );
  }

  const parsed = parseRef(trimmed);
  const sibling: DependencyRef = { kind: "sibling", namespace: parsed.namespace };
  if (parsed.recipe !== undefined) sibling.recipe = parsed.recipe;
  if (parsed.range !== undefined) sibling.range = parsed.range;
  return sibling;
}

/**
 * Parses the locator form, whose scheme is the provider's identifier.
 *
 * The path is read from the RIGHT: the last two segments are always the
 * namespace and the recipe, because they are the recipe's published identity
 * and never a filesystem path. Everything before them is the repository, whose
 * first segment is the host when it carries a dot and otherwise the provider's
 * own public host.
 *
 * @param input - The dependency as written, for error messages.
 * @param scheme - The scheme, which names the provider.
 * @param rest - Everything after the `://`.
 */
function parseRemoteDependency(
  input: string,
  scheme: string,
  rest: string
): DependencyRef {
  const provider = scheme.toLowerCase();

  if (provider === "local") {
    throw dependencyError(
      input,
      "a local repository is a consumer's convenience, not a published location, so a " +
        "manifest cannot depend on one. Publish the recipe and depend on it by its " +
        "published location."
    );
  }

  const defaultHost = DEPENDENCY_PROVIDER_HOSTS[provider];
  if (defaultHost === undefined) {
    const known = Object.keys(DEPENDENCY_PROVIDER_HOSTS).sort().join(", ");
    throw dependencyError(
      input,
      `'${provider}' is not a provider sous can fetch from. The scheme of a locator URL ` +
        `is the provider's own identifier; sous ships these: ${known}.`
    );
  }

  let body = rest.trim();
  let range: string | undefined;
  const atIndex = body.indexOf("@");
  if (atIndex !== -1) {
    if (body.indexOf("@", atIndex + 1) !== -1) {
      throw dependencyError(input, "a dependency may carry at most one '@' version range.");
    }
    range = body.slice(atIndex + 1).trim();
    body = body.slice(0, atIndex);
    if (range.length === 0) {
      throw dependencyError(input, "the '@' is not followed by a version range.");
    }
    if (semver.validRange(range) === null) {
      throw dependencyError(
        input,
        `'${range}' is not a version range. Ranges follow npm's rules, such as '^1.2.0', ` +
          "'~2.1', '>=1.0.0 <2.0.0' or '*'."
      );
    }
  }

  const segments = body.split("/").filter((segment) => segment.length > 0);

  // The recipe is two segments and a repository is at least an owner and a
  // name, so four is the shortest locator that can mean anything.
  if (segments.length < 4) {
    throw dependencyError(
      input,
      "a locator URL names a repository and then the recipe inside it, as in " +
        "'github://owner/repository/namespace/recipe'. The last two segments are always " +
        "the namespace and the recipe."
    );
  }

  const recipe = segments.pop()!;
  const namespace = segments.pop()!;

  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw dependencyError(
      input,
      `the namespace '${namespace}' must be lowercase kebab-case: a letter, then letters, ` +
        "digits or hyphens."
    );
  }
  if (!RECIPE_NAME_PATTERN.test(recipe)) {
    throw dependencyError(
      input,
      `the recipe name '${recipe}' must be lowercase kebab-case: a letter, then letters, ` +
        "digits or hyphens."
    );
  }

  const first = segments[0]!;
  const hasHost = first.includes(".");
  const host = (hasHost ? first : defaultHost).toLowerCase();
  const pathSegments = hasHost ? segments.slice(1) : segments;

  if (pathSegments.length < 2) {
    const what =
      pathSegments.length === 0 ? "nothing" : `only '${pathSegments.join("/")}'`;
    throw dependencyError(
      input,
      `the host '${host}' is followed by ${what}, and a repository is named by an owner ` +
        "and a repository name, as in " +
        "'gitlab://gitlab.example.com/group/subgroup/project/namespace/recipe'."
    );
  }

  const repoPath = pathSegments.join("/").replace(/\.git$/i, "");

  return {
    kind: "remote",
    provider,
    host,
    repoPath,
    canonicalRepo: `${host}/${repoPath}`.toLowerCase(),
    namespace,
    recipe,
    ...(range === undefined ? {} : { range }),
  };
}

/**
 * The recipe key a dependency names: `namespace/recipe`, or the bare namespace
 * when a sibling ref named a whole namespace. This is what the index, the
 * lockfile and the store all file a recipe under.
 *
 * @param parsed - The parsed dependency.
 */
export function dependencyRefKey(parsed: DependencyRef): string {
  return parsed.recipe === undefined
    ? parsed.namespace
    : `${parsed.namespace}/${parsed.recipe}`;
}

/**
 * Renders a parsed dependency back into the form a manifest writes. Round-trips
 * with parseDependencyRef, apart from surrounding whitespace and a host that was
 * left implicit.
 *
 * @param parsed - The parsed dependency.
 */
export function formatDependencyRef(parsed: DependencyRef): string {
  const key = dependencyRefKey(parsed);
  const range = parsed.range === undefined ? "" : `@${parsed.range}`;
  if (parsed.kind === "sibling") return `${key}${range}`;
  return `${parsed.provider}://${parsed.host}/${parsed.repoPath}/${key}${range}`;
}

/**
 * Parses a dependency, returning undefined instead of throwing. Use this where
 * a bad dependency is reported through another mechanism, such as a zod issue.
 *
 * @param input - The dependency as written.
 */
export function tryParseDependencyRef(input: string): DependencyRef | undefined {
  try {
    return parseDependencyRef(input);
  } catch {
    return undefined;
  }
}

/**
 * The HTTPS location a remote dependency points at, which is what `sous repo
 * add` would be given for it.
 *
 * @param parsed - A parsed remote dependency.
 */
export function dependencyRepoUrl(parsed: DependencyRef): string | undefined {
  if (parsed.kind !== "remote") return undefined;
  return `https://${parsed.host}/${parsed.repoPath}`;
}
