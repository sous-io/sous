/**
 * The format parsers as services: each wraps one zod schema from `./formats/` in the
 * `FormatParser` shape the contract names.
 */

import type { z } from "zod";
import { checkFormat, parseFormat, stableJsonStringify } from "./formats/common.js";
import { indexFileSchema } from "./formats/index-file.js";
import { linksMapSchema, createEmptyLinksMap } from "./formats/links-map.js";
import { createEmptyLockfile, lockfileSchema } from "./formats/lockfile.js";
import { createRecipeManifestSchema, type DependencyRefChecker } from "./formats/recipe-manifest.js";
import { repoManifestSchema } from "./formats/repo-manifest.js";
import { storeEntrySchema } from "./formats/store-entry.js";
import { variableDefinitionSchema } from "./formats/variable-definition.js";
import {
  INDEX_FILENAME,
  LINKS_FILENAME,
  LOCKFILE_FILENAME,
  STORE_ENTRY_FILENAME,
} from "./formats/common.js";
import type {
  FormatParser,
  IndexFile,
  LinksMap,
  Lockfile,
  RecipeManifest,
  RepoManifest,
  StoreEntry,
  VariableDefinition,
  WritableFormatParser,
} from "./types.js";

/** Wraps a schema as a `FormatParser`; `T` is the contract type the schema's output is read as. */
function readOnly<T>(label: string, schema: z.ZodType, fileName?: string): FormatParser<T> {
  return {
    label,
    ...(fileName === undefined ? {} : { fileName }),
    parse: (value, sourceLabel) => parseFormat(schema, value, sourceLabel, label) as T,
    check: (value, sourceLabel) => {
      const result = checkFormat(schema, value);
      return result.issues === undefined
        ? { value: result.value as T }
        : { issues: [`Invalid ${label} at ${sourceLabel}:`, ...result.issues] };
    },
  };
}

/** Wraps a schema as a `WritableFormatParser`: stable JSON out, sorted keys and a trailing newline. */
function writable<T>(label: string, schema: z.ZodType, fileName: string, empty: () => T): WritableFormatParser<T> {
  return { ...readOnly<T>(label, schema, fileName), stringify: stableJsonStringify, empty };
}

/** `formats.lockfile`. */
export const lockfileFormat = writable<Lockfile>(
  "lockfile",
  lockfileSchema,
  LOCKFILE_FILENAME,
  createEmptyLockfile as () => Lockfile
);

/** `formats.links-map`. */
export const linksMapFormat = writable<LinksMap>(
  "links map",
  linksMapSchema,
  LINKS_FILENAME,
  createEmptyLinksMap as () => LinksMap
);

/** `formats.index-file`. An empty index has no name or generator; it is a starting point to fill in. */
export const indexFileFormat = writable<IndexFile>("index file", indexFileSchema, INDEX_FILENAME, () => ({
  formatVersion: 1,
  name: "",
  generatedAt: new Date(0).toISOString(),
  generator: "",
  namespaces: {},
  recipes: {},
}));

/** `formats.store-entry`. An empty entry holds blank fields to fill in. */
export const storeEntryFormat = writable<StoreEntry>("store entry", storeEntrySchema, STORE_ENTRY_FILENAME, () => ({
  formatVersion: 1,
  repo: "",
  namespace: "",
  name: "",
  version: "",
  hash: `sha256-${"0".repeat(64)}`,
  fetchedAt: new Date(0).toISOString(),
  lastAccessAt: new Date(0).toISOString(),
  sizeBytes: 0,
}));

/** `formats.repo-manifest`. */
export const repoManifestFormat = readOnly<RepoManifest>("repo manifest", repoManifestSchema);

/** `formats.variable-definition`. */
export const variableDefinitionFormat = readOnly<VariableDefinition>(
  "variable definition",
  variableDefinitionSchema
);

/**
 * `formats.recipe-manifest`, with the given check for the refs in `depends` and `subscribes`
 * (`refs.resolver`'s manifest parse, when the plugin has it).
 */
export function createRecipeManifestFormat(checkRef?: DependencyRefChecker): FormatParser<RecipeManifest> {
  return readOnly<RecipeManifest>("recipe manifest", createRecipeManifestSchema(checkRef));
}
