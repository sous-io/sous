/**
 * Generates the committed `sous.config.schema.json` at the repository root,
 * the JSON Schema a sous config file binds to through its `$schema` field, so
 * an editor can complete and check it. `@sous-io/sous` ships it (see
 * `packages/sous/scripts/pack-files.mjs`), and `sous init` points new configs
 * at the copy tagged with the running version.
 *
 * There is no single hand-written schema any more: each plugin declares the
 * config keys it owns, each with its own schema, as `config-key` entities. So
 * the script starts a sous engine with the built-in plugins and no project,
 * the same set the published bin loads, collects every key, and nests each
 * key's JSON Schema under its path (`recipes.skills` lands at
 * `properties.recipes.properties.skills`). The top level allows no other key,
 * matching sous, which rejects an unknown top-level key as a likely typo.
 *
 * A key whose schema cannot describe itself as JSON Schema is written with
 * only its description, so the file accepts any value there; sous still checks
 * it when it loads the config. The script names each such key.
 *
 * Run it whenever a plugin adds, removes or changes a config key:
 *
 *     pnpm schema:build
 *
 * It reads the workspace packages from their TypeScript source, so nothing has
 * to be built first (see `lib/from-source.mts`). The engine runs in an empty
 * temporary directory, with HOME pointing there too, so neither this checkout's
 * own `.sous/` nor the machine's user config can add plugins or keys.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFromSource } from "./lib/from-source.mts";

runFromSource(import.meta.url);

const { createEngine } = await import("../packages/core/src/index.js");
const { BUILT_IN_PLUGINS, sousVersion } = await import("../packages/sous/src/index.js");
const { toJsonSchema } = await import("../packages/plugin-api/src/index.js");
const { parsePath } = await import("../packages/documents/src/index.js");

type JsonSchema = Record<string, unknown>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "sous.config.schema.json");

/** Every config key the built-in plugins declare, with its JSON Schema when it has one. */
async function collectKeys(): Promise<{ id: string; description?: string; schema?: JsonSchema }[]> {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-schema-build-"));
  try {
    const engine = createEngine({
      env: { HOME: emptyDir },
      cwd: emptyDir,
      app: { name: "sous", version: sousVersion() },
      builtIns: BUILT_IN_PLUGINS,
    });
    const built = await engine.buildConfig();

    return built.entities.list("config-key").map((key) => ({
      id: key.id,
      ...(key.description === undefined ? {} : { description: key.description }),
      ...(toJsonSchema(key.schema) === undefined ? {} : { schema: toJsonSchema(key.schema) as JsonSchema }),
    }));
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

/** A copy of a schema without `$schema` anywhere inside it; only the file's root names the draft. */
function withoutDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDialect);
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => name !== "$schema")
      .map(([name, inner]) => [name, withoutDialect(inner)])
  );
}

/**
 * The object schema at a path below the root, made on the way when a key's
 * parent declares no schema of its own (or one with no `properties` yet).
 */
function objectAt(root: JsonSchema, segments: readonly string[]): JsonSchema {
  let node = root;
  for (const segment of segments) {
    const properties = (node.properties ??= {}) as Record<string, JsonSchema>;
    node = properties[segment] ??= { type: "object" };
  }
  return node;
}

const keys = await collectKeys();
const root: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://sous-io.github.io/sous/sous.config.schema.json",
  title: "Sous config",
  type: "object",
  properties: {},
  additionalProperties: false,
};
const undescribed: string[] = [];

// Parents before children, so a nested key is added inside its parent's schema.
const ordered = keys
  .map((key) => ({ ...key, path: parsePath(key.id).map(String) }))
  .sort((a, b) => a.path.length - b.path.length || a.id.localeCompare(b.id));

for (const key of ordered) {
  const parent = objectAt(root, key.path.slice(0, -1));
  const properties = (parent.properties ??= {}) as Record<string, JsonSchema>;
  const name = key.path[key.path.length - 1]!;
  if (key.schema === undefined) undescribed.push(key.id);

  const own = (key.schema === undefined ? {} : withoutDialect(key.schema)) as JsonSchema;
  properties[name] = {
    ...(key.description === undefined ? {} : { description: key.description }),
    ...own,
  };
}

fs.writeFileSync(outputPath, JSON.stringify(root, null, 2) + "\n");
console.log(`Wrote ${path.relative(repoRoot, outputPath)}, with ${keys.length} config keys.`);
if (undescribed.length > 0) {
  console.log(
    `These keys have no JSON Schema of their own, so the file accepts any value for them: ${undescribed.join(", ")}.`
  );
}
