/**
 * Builders the ref resolver specs share: partial refs, plain refs, indexes and
 * variable definitions, all made in memory.
 */

import { parseIndexFile, type IndexFile } from "../../lib/repos/formats/index-file.js";
import type { DefinedVariable } from "../../lib/vars/definition-source.js";
import type { PartialRef } from "../../services/ref-resolver/parser/partial-ref.js";
import { getSharedRefContainer } from "../../services/ref-resolver/container.js";
import { formatRef, refKey } from "../../services/ref-resolver/format.js";
import type { RefLookup, RefMatch } from "../../services/ref-resolver/lookups/ref-lookup.js";
import type { RefParser } from "../../services/ref-resolver/parser/ref-parser.js";
import { REF_TOKENS } from "../../services/ref-resolver/tokens.js";
import type {
  NamespaceRef,
  RecipeRef,
  RepoRef,
  SousRef,
} from "../../services/ref-resolver/types.js";

/** An unread reading of some text, with an empty problem list. */
export function stateOf(rest: string, extra: Partial<PartialRef> = {}): PartialRef {
  return { input: rest, rest, problems: [], ...extra };
}

/** A namespace ref, optionally inside a repository known by short name. */
export function nsRef(name: string, repo?: string): NamespaceRef {
  return { kind: "namespace", name, ...(repo === undefined ? {} : { repo: repoRef(repo) }) };
}

/** A repository ref known by short name. */
export function repoRef(name: string): RepoRef {
  return { kind: "repo", name };
}

/** A recipe ref with its namespace, optionally inside a repository known by short name. */
export function recipeRef(namespace: string, name: string, repo?: string): RecipeRef {
  return { kind: "recipe", name, namespace: nsRef(namespace, repo) };
}

/** Every ref printed in its canonical form, with its kind. */
export function printed(refs: SousRef[]): string[] {
  return refs.map((ref) => `${ref.kind}:${formatRef(ref)}`);
}

/** A validated index publishing the given `namespace/recipe` keys, each in `recipes/<key>`. */
export function indexOf(keys: string[], descriptions: Record<string, string> = {}): IndexFile {
  const namespaces: Record<string, object> = {};
  const recipes: Record<string, object> = {};
  for (const key of keys) {
    namespaces[key.split("/")[0]!] = {};
    recipes[key] = {
      path: `recipes/${key}`,
      ...(descriptions[key] === undefined ? {} : { description: descriptions[key] }),
      versions: {
        "1.0.0": { hash: `sha256-${"a".repeat(64)}`, tag: `${key}@1.0.0`, prerelease: false },
      },
    };
  }
  return parseIndexFile(
    {
      formatVersion: 1,
      name: "fixture",
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "0.0.1",
      namespaces,
      recipes,
    },
    "test index"
  );
}

/** One variable definition published by one recipe. */
export function variableOf(
  repo: string,
  namespace: string,
  recipe: string,
  name: string,
  env?: string
): DefinedVariable {
  return {
    definition: {
      name,
      type: "string",
      prompt: `What is ${name}?`,
      description: `The ${name} setting.`,
      example: "example",
      required: true,
      secret: false,
      scope: "shared",
      ...(env === undefined ? {} : { env }),
    } as DefinedVariable["definition"],
    recipe: { repo, namespace, name: recipe, version: "1.0.0" },
  };
}

/** Every reading of a written ref, straight from the shared parser (nothing pruned). */
export function candidates(text: string): SousRef[] {
  return getSharedRefContainer().get<RefParser>(REF_TOKENS.Parser).parse(text);
}

/** Everything a lookup knows about any reading of a written ref. */
export async function findAll(lookup: RefLookup, text: string): Promise<RefMatch[]> {
  const matches: RefMatch[] = [];
  for (const candidate of candidates(text)) matches.push(...(await lookup.find(candidate)));
  return matches;
}

/** Matches printed as their keys, marking those that matched only ignoring case. */
export function keysOf(matches: RefMatch[]): string[] {
  return matches.map((match) => `${match.ref.kind}:${refKey(match.ref)}${match.exactSpelling ? "" : " (folded)"}`);
}
