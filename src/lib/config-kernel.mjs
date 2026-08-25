/**
 * The sous "config kernel": a single loader subprocess that turns an ordered
 * list of config layer files into ONE merged, plain-JSON config.
 *
 * Spawned by loadSettings (src/lib/settings.ts). Plain JavaScript ESM, no
 * TypeScript syntax — it must run under bare Node AND under the tsx loader
 * (the tsx attempt exists so user configs may use TypeScript syntax). It ships
 * to npm via the package.json "files": "src" allowlist.
 *
 * Protocol
 * --------
 * stdin (one JSON document):
 *   {
 *     sources: string[],            // ordered absolute layer paths, primary first
 *     context: { sousDir, confDir, sousRootPath, sousVersion, configPath },
 *     trace: boolean
 *   }
 *
 * stdout (one JSON document):
 *   { config, layers }
 *   `layers` is [] unless trace; when tracing it holds one { path, config }
 *   snapshot of the CUMULATIVE config after each top-level source. Builder
 *   sub-loads (loadConfig/loadConfigs) fold into the enclosing layer's snapshot.
 *
 * Any layer failure (parse error, import error, configure() throw, cycle,
 * old multi-project schema) writes a message NAMING THE LAYER FILE to stderr
 * and exits 1; the parent wraps stderr in a ConfigError.
 *
 * Layer contract
 * --------------
 * - .json  → JSON.parse of the file text.
 * - .yaml  → parsed with the 'yaml' package.
 * - .js/.mjs → dynamic import. The module may export:
 *     * an object: `config`, else `default` when it is a non-function object;
 *     * a function: `configure`, else `default` when it is a function;
 *     * both: the object merges FIRST, then the function runs.
 *   The function is awaited: `await fn(currentConfig, builder)`. It may mutate
 *   `currentConfig` by reference freely; a returned object (if any) is merged
 *   after it resolves.
 *
 * Every layer object is forced through a JSON round-trip BEFORE merging, so
 * functions, RegExp, Date and undefined values drop at the layer boundary.
 * The final cumulative config is JSON round-tripped again on the way out.
 *
 * Merge semantics (deepMerge): plain object + plain object → recurse;
 * array + array → concatenate (target then source); anything else → the
 * source value replaces. No dedupe.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { globSync } from "glob";

// --- small utilities -----------------------------------------------------------------------------

/** True for a plain object (not null, not an array). */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Forces a value through a JSON round-trip. */
function jsonRoundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Bytewise string comparison (plain `<` on the string), locale-independent so
 * layer order is identical on every machine. NOT numeric: '10-' sorts before '2-'.
 */
function bytewiseCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deep-merges `source` INTO `target` (the live cumulative config).
 * plain object + plain object → recurse; array + array → concatenate
 * (target then source, no dedupe); anything else → source replaces.
 */
function deepMerge(target, source) {
  for (const [key, sourceValue] of Object.entries(source)) {
    // Guard against prototype pollution: a JSON layer can carry an OWN
    // enumerable "__proto__" (or "constructor"/"prototype") key through the
    // round-trip; merging it would mutate Object.prototype and corrupt every
    // later object (including tripping the old-schema guard on innocent layers).
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const targetValue = target[key];
    if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
      deepMerge(targetValue, sourceValue);
    } else if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
      target[key] = [...targetValue, ...sourceValue];
    } else {
      target[key] = sourceValue;
    }
  }
  return target;
}

// --- kernel --------------------------------------------------------------------------------------

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const { sources, context, trace } = JSON.parse(await readStdin());

  /** The live cumulative config every layer merges into. */
  const currentConfig = {};

  /** Trace-mode snapshots: one per TOP-LEVEL source, taken after it finishes. */
  const layers = [];

  /** Absolute paths currently mid-load, for cycle detection. */
  const loadingSet = new Set();

  /** The layer file whose code is currently executing (for builder.currentFile). */
  let currentFile = null;

  /**
   * The only variables usable in builder loadConfig/loadConfigs paths. Builder
   * paths resolve BEFORE variable resolution, so user _vars do not exist yet.
   */
  const autoVars = {
    sousDir: context.sousDir,
    sousConfDir: context.confDir,
    sousRootPath: context.sousRootPath,
    sousVersion: context.sousVersion,
  };

  /** Substitutes ${autoVar} references in a builder path; any other var is fatal. */
  function substituteAutoVars(rawPath, where) {
    return rawPath.replace(/\$\{([^}]+)\}/g, (_match, name) => {
      if (name in autoVars) return autoVars[name];
      throw new Error(
        `${where}: \${${name}} cannot be used in a builder path.\n` +
          `  Builder paths (loadConfig/loadConfigs) resolve BEFORE variable resolution, so user\n` +
          `  _vars are not available yet. Only these auto-vars are allowed:\n` +
          `    ${Object.keys(autoVars)
            .map((n) => "${" + n + "}")
            .join(", ")}`
      );
    });
  }

  /** Resolves a builder path: auto-vars, then relative-to-the-current-layer-file. */
  function resolveBuilderPath(rawPath, where) {
    const substituted = substituteAutoVars(String(rawPath), where);
    if (path.isAbsolute(substituted)) return path.normalize(substituted);
    return path.resolve(path.dirname(currentFile), substituted);
  }

  /**
   * Guards against the removed multi-project schema, per layer, so the error
   * names the exact file that still uses it.
   */
  function assertNotOldSchema(layerObject, filePath) {
    if (isPlainObject(layerObject) && ("projects" in layerObject || "defaultProject" in layerObject)) {
      throw new Error(
        `Config layer ${filePath} uses the removed multi-project schema ` +
          `('projects' / 'defaultProject').\n` +
          `  A sous config now describes exactly one project. To migrate:\n` +
          `    1. Move your single project's fields (name, _vars, _aliases, compilation,\n` +
          `       runtimeContext, tools) to the top level of the config.\n` +
          `    2. Delete the 'projects' and 'defaultProject' keys.\n` +
          `  A config with several projects must be split into one config per project.`
      );
    }
  }

  /**
   * JSON-forces a layer's object and deep-merges it into the live config.
   * Runs the old-schema guard on the layer's OWN object, pre-merge.
   */
  function mergeLayerObject(layerObject, filePath) {
    if (!isPlainObject(layerObject)) {
      throw new Error(
        `Config layer ${filePath} did not produce a plain object (got ${
          Array.isArray(layerObject) ? "an array" : typeof layerObject
        }).`
      );
    }
    assertNotOldSchema(layerObject, filePath);
    deepMerge(currentConfig, jsonRoundTrip(layerObject));
  }

  /**
   * The builder singleton passed to every configure(currentConfig, builder).
   * One instance per kernel run; `currentFile` tracks whichever layer is executing.
   */
  const builder = {
    get config() {
      return currentConfig;
    },
    sousDir: context.sousDir,
    confDir: context.confDir,
    get currentFile() {
      return currentFile;
    },
    env(name, fallback) {
      return process.env[name] ?? fallback;
    },
    merge(obj) {
      mergeLayerObject(obj, currentFile ?? "<builder.merge>");
    },
    async loadConfig(p) {
      await loadLayer(resolveBuilderPath(p, `loadConfig(${JSON.stringify(p)}) in ${currentFile}`));
    },
    async loadConfigs(globPattern) {
      const where = `loadConfigs(${JSON.stringify(globPattern)}) in ${currentFile}`;
      const pattern = resolveBuilderPath(globPattern, where);
      const matches = globSync(pattern, { absolute: true })
        .filter((p) => fs.statSync(p).isFile())
        .sort(bytewiseCompare);
      for (const match of matches) {
        await loadLayer(match);
      }
    },
  };

  /**
   * Loads ONE layer file (any extension) and merges it into the cumulative
   * config. Builder sub-loads recurse here too, under the full layer contract
   * (including nested configure), guarded by the loading-set cycle check.
   */
  async function loadLayer(filePath) {
    const resolved = path.resolve(filePath);

    if (loadingSet.has(resolved)) {
      throw new Error(
        `Config layer cycle detected: ${resolved} is already being loaded.\n` +
          `  Load chain: ${[...loadingSet].join(" -> ")} -> ${resolved}`
      );
    }
    if (!fs.existsSync(resolved)) {
      throw new Error(`Config layer not found: ${resolved}`);
    }

    loadingSet.add(resolved);
    const previousFile = currentFile;
    currentFile = resolved;

    try {
      const ext = path.extname(resolved).toLowerCase();

      if (ext === ".json") {
        mergeLayerObject(JSON.parse(fs.readFileSync(resolved, "utf8")), resolved);
      } else if (ext === ".yaml") {
        mergeLayerObject(parseYaml(fs.readFileSync(resolved, "utf8")), resolved);
      } else if (ext === ".js" || ext === ".mjs") {
        const mod = await import(pathToFileURL(resolved).href);

        let configObject;
        if (mod.config !== undefined) {
          configObject = mod.config;
        } else if (mod.default !== undefined && typeof mod.default !== "function") {
          configObject = mod.default;
        }

        let configureFn;
        if (typeof mod.configure === "function") {
          configureFn = mod.configure;
        } else if (typeof mod.default === "function") {
          configureFn = mod.default;
        }

        if (configObject === undefined && configureFn === undefined) {
          throw new Error(
            `Config layer ${resolved} exports neither a config object ` +
              `(\`config\` or a default object) nor a configure function ` +
              `(\`configure\` or a default function).`
          );
        }

        // When both exist, the object merges FIRST, then the function runs.
        if (configObject !== undefined) {
          mergeLayerObject(configObject, resolved);
        }
        if (configureFn !== undefined) {
          const returned = await configureFn(currentConfig, builder);
          if (returned !== undefined && returned !== null) {
            mergeLayerObject(returned, resolved);
          }
        }
      } else {
        throw new Error(
          `Config layer ${resolved} has an unsupported extension '${ext}'. ` +
            `Supported: .js, .mjs, .json, .yaml`
        );
      }
    } catch (error) {
      // Make sure every failure names a layer file.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(resolved)) throw error;
      throw new Error(`Config layer ${resolved} failed to load: ${message}`);
    } finally {
      loadingSet.delete(resolved);
      currentFile = previousFile;
    }
  }

  for (const source of sources) {
    await loadLayer(source);
    if (trace) {
      layers.push({ path: source, config: jsonRoundTrip(currentConfig) });
    }
  }

  process.stdout.write(JSON.stringify({ config: jsonRoundTrip(currentConfig), layers }));
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
