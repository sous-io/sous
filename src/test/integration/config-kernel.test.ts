import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { discoverConfig, type DiscoveredConfig } from "../../lib/config-discovery.js";
import { loadSettings, loadSettingsWithLayers, type Settings } from "../../lib/settings.js";

/**
 * These tests drive the REAL config kernel: loadSettings/loadSettingsWithLayers
 * spawn src/lib/config-kernel.mjs in a subprocess, so every case here exercises
 * actual file loading, deep-merge, configure() execution and JSON forcing.
 *
 * The kernel spawn costs ~100ms (twice: a node attempt then a tsx fallback), so
 * the file as a whole takes tens of seconds; each individual test stays small.
 */

// A generous per-test timeout: the kernel is a real subprocess.
const T = 30000;

describe("config kernel (real subprocess)", () => {
  let tmp: TmpDir;
  let root: string;
  let sousDir: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    root = tmp.path;
    sousDir = path.join(root, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    // Mark the tmp tree as ESM so bare `.js` layer files import as ES modules
    // under the kernel's node-first spawn attempt.
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** Writes a file under .sous/, creating parent dirs. `rel` is relative to .sous/. */
  function write(rel: string, content: string): string {
    const full = path.join(sousDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    return full;
  }

  /** Discovers the config just written under .sous/ (primary + conf.d layers). */
  function discover(): DiscoveredConfig {
    const found = discoverConfig(root);
    if (!found) throw new Error("test setup: no config discovered");
    return found;
  }

  // --- merge order + array/scalar/object semantics ---------------------------------------------

  it(
    "merges primary first, then conf.d layers in bytewise filename order",
    async () => {
      // Uses _aliases (a schema-valid record of string arrays) as the array-merge
      // probe: same key across layers concatenates, so its final value reveals order.
      write("sous.config.json", JSON.stringify({ _aliases: { order: ["primary"] } }));
      write("conf.d/10-a.json", JSON.stringify({ _aliases: { order: ["a"] } }));
      write("conf.d/20-b.json", JSON.stringify({ _aliases: { order: ["b"] } }));

      const settings = await loadSettings(discover());
      expect(settings._aliases?.order).toEqual(["primary", "a", "b"]);
    },
    T
  );

  it(
    "sorts conf.d bytewise, so '10-' loads before '2-'",
    async () => {
      write("sous.config.json", JSON.stringify({ _aliases: { order: ["primary"] } }));
      write("conf.d/2-late.json", JSON.stringify({ _aliases: { order: ["two"] } }));
      write("conf.d/10-early.json", JSON.stringify({ _aliases: { order: ["ten"] } }));

      const settings = await loadSettings(discover());
      // Bytewise (not numeric): "10-early" < "2-late".
      expect(settings._aliases?.order).toEqual(["primary", "ten", "two"]);
    },
    T
  );

  it(
    "later layers win for scalars",
    async () => {
      write("sous.config.json", JSON.stringify({ name: "first" }));
      write("conf.d/50-override.json", JSON.stringify({ name: "second" }));

      const settings = await loadSettings(discover());
      expect(settings.name).toBe("second");
    },
    T
  );

  it(
    "deep-merges nested objects across layers",
    async () => {
      write("sous.config.json", JSON.stringify({ _vars: { a: "1" } }));
      write("conf.d/50-more.json", JSON.stringify({ _vars: { b: "2" } }));

      const settings = await loadSettings(discover());
      expect(settings._vars).toEqual({ a: "1", b: "2" });
    },
    T
  );

  it(
    "concatenates arrays across layers (both compilation targets, in order)",
    async () => {
      write(
        "sous.config.json",
        JSON.stringify({
          compilation: { targets: [{ entryPoint: "a.md", outputs: [] }] },
        })
      );
      write(
        "conf.d/50-second-target.json",
        JSON.stringify({
          compilation: { targets: [{ entryPoint: "b.md", outputs: [] }] },
        })
      );

      const settings = await loadSettings(discover());
      expect(settings.compilation?.targets.map((t) => t.entryPoint)).toEqual(["a.md", "b.md"]);
    },
    T
  );

  // --- per-extension loading --------------------------------------------------------------------

  it(
    "parses a yaml layer",
    async () => {
      write("sous.config.json", JSON.stringify({ name: "json-primary" }));
      write("conf.d/50-extra.yaml", "name: yaml-layer\n_vars:\n  fromYaml: yes-it-works\n");

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.name).toBe("yaml-layer");
      expect(settings._vars).toEqual({ fromYaml: "yes-it-works" });
    },
    T
  );

  it(
    "loads a js layer that exports only a config object",
    async () => {
      write("sous.config.mjs", `export const config = { name: "from-config-export", _vars: { x: "1" } };\n`);

      const settings = await loadSettings(discover());
      expect(settings.name).toBe("from-config-export");
      expect(settings._vars).toEqual({ x: "1" });
    },
    T
  );

  it(
    "runs a configure() export that mutates currentConfig by reference",
    async () => {
      // Mutations land in schema-valid locations (name + _vars) so the merged
      // config still validates; the point is that configure() sees currentConfig.
      write(
        "sous.config.mjs",
        `export const config = { name: "seed" };
export function configure(cfg) { cfg._vars = { mutated: "yes", sawName: cfg.name }; }
`
      );

      const settings = await loadSettings(discover());
      expect(settings._vars?.mutated).toBe("yes");
      expect(settings._vars?.sawName).toBe("seed");
    },
    T
  );

  it(
    "merges the config object BEFORE running configure() when a file exports both",
    async () => {
      write(
        "sous.config.mjs",
        `export const config = { _vars: { seed: "objval" } };
export function configure(cfg) { cfg._vars.readBack = cfg._vars.seed + "-seen"; }
`
      );

      const settings = await loadSettings(discover());
      // Proof of ordering: configure could only read seed if the object merged first.
      expect(settings._vars?.seed).toBe("objval");
      expect(settings._vars?.readBack).toBe("objval-seen");
    },
    T
  );

  it(
    "accepts a default-export object",
    async () => {
      write("sous.config.mjs", `export default { name: "default-object", _vars: { a: "1" } };\n`);

      const settings = await loadSettings(discover());
      expect(settings.name).toBe("default-object");
      expect(settings._vars).toEqual({ a: "1" });
    },
    T
  );

  it(
    "accepts a default-export function as configure()",
    async () => {
      write("sous.config.mjs", `export default (cfg) => { cfg.name = "via-default-fn"; };\n`);

      const settings = await loadSettings(discover());
      expect(settings.name).toBe("via-default-fn");
    },
    T
  );

  it(
    "awaits an async configure()",
    async () => {
      write(
        "sous.config.mjs",
        `export async function configure(cfg) {
  const v = await Promise.resolve("async-value");
  cfg._vars = { asyncField: v };
}
`
      );

      const settings = await loadSettings(discover());
      expect(settings._vars?.asyncField).toBe("async-value");
    },
    T
  );

  it(
    "merges a value returned from configure()",
    async () => {
      write(
        "sous.config.mjs",
        `export function configure() { return { _vars: { returned: "merged-after" } }; }\n`
      );

      const settings = await loadSettings(discover());
      expect(settings._vars?.returned).toBe("merged-after");
    },
    T
  );

  it(
    "does not duplicate arrays when configure() mutates AND returns currentConfig",
    async () => {
      // Regression: the mutate-and-return-for-chaining pattern (`return cfg;`)
      // used to deepMerge currentConfig onto itself, concatenating every array
      // (so compilation.targets doubled and sous compiled/pruned each output twice).
      write(
        "sous.config.mjs",
        `export function configure(cfg) {
  cfg.compilation = { targets: [{ entryPoint: "a.md", outputs: [] }, { entryPoint: "b.md", outputs: [] }] };
  return cfg;
}
`
      );

      const settings = await loadSettings(discover());
      expect(settings.compilation?.targets.map((t) => t.entryPoint)).toEqual(["a.md", "b.md"]);
    },
    T
  );

  it(
    "does not duplicate arrays when configure() returns builder.config",
    async () => {
      write(
        "sous.config.mjs",
        `export function configure(cfg, builder) {
  cfg._aliases = { order: ["x", "y"] };
  return builder.config;
}
`
      );

      const settings = await loadSettings(discover());
      expect(settings._aliases?.order).toEqual(["x", "y"]);
    },
    T
  );

  // --- builder API ------------------------------------------------------------------------------

  it(
    "supports builder.merge()",
    async () => {
      write(
        "sous.config.mjs",
        `export function configure(cfg, builder) { builder.merge({ _vars: { extra: "via-merge" } }); }\n`
      );

      const settings = await loadSettings(discover());
      expect(settings._vars?.extra).toBe("via-merge");
    },
    T
  );

  it(
    "supports builder.env() with a fallback and reading a set variable",
    async () => {
      process.env.SOUS_KERNEL_TEST_VAR = "from-env";
      try {
        write(
          "sous.config.mjs",
          `export function configure(cfg, builder) {
  cfg._vars = {
    present: builder.env("SOUS_KERNEL_TEST_VAR", "fallback"),
    missing: builder.env("SOUS_KERNEL_DEFINITELY_UNSET", "fallback-used"),
  };
}
`
        );

        const settings = await loadSettings(discover());
        expect(settings._vars?.present).toBe("from-env");
        expect(settings._vars?.missing).toBe("fallback-used");
      } finally {
        delete process.env.SOUS_KERNEL_TEST_VAR;
      }
    },
    T
  );

  it(
    "supports builder.loadConfig() with a relative path and a ${sousDir} auto-var path",
    async () => {
      // These sub-configs live outside conf.d so only the builder loads them.
      write("extra/rel.json", JSON.stringify({ _vars: { fromRelative: "yes" } }));
      write("extra/abs.json", JSON.stringify({ _vars: { fromAutoVar: "yes" } }));
      write(
        "sous.config.mjs",
        `export async function configure(cfg, builder) {
  await builder.loadConfig("./extra/rel.json");
  await builder.loadConfig("\${sousDir}/extra/abs.json");
}
`
      );

      const settings = await loadSettings(discover());
      expect(settings._vars?.fromRelative).toBe("yes");
      expect(settings._vars?.fromAutoVar).toBe("yes");
    },
    T
  );

  it(
    "supports builder.loadConfigs() globbing in bytewise order",
    async () => {
      write("parts/20-b.json", JSON.stringify({ _aliases: { order: ["b"] } }));
      write("parts/10-a.json", JSON.stringify({ _aliases: { order: ["a"] } }));
      write(
        "sous.config.mjs",
        `export async function configure(cfg, builder) {
  cfg._aliases = { order: ["primary"] };
  await builder.loadConfigs("\${sousDir}/parts/*.json");
}
`
      );

      const settings = await loadSettings(discover());
      expect(settings._aliases?.order).toEqual(["primary", "a", "b"]);
    },
    T
  );

  it(
    "rejects an unknown ${var} in a builder path, listing the allowed auto-vars",
    async () => {
      write(
        "sous.config.mjs",
        `export async function configure(cfg, builder) {
  await builder.loadConfig("\${bogusVar}/nope.json");
}
`
      );

      await expect(loadSettings(discover())).rejects.toThrow(/bogusVar/);
      await expect(loadSettings(discover())).rejects.toThrow(/sousConfDir/);
    },
    T
  );

  // --- failure modes ----------------------------------------------------------------------------

  it(
    "rejects a broken-JSON layer, naming the file",
    async () => {
      write("sous.config.json", JSON.stringify({ name: "ok" }));
      write("conf.d/50-broken.json", "{ this is not: valid json ]");

      await expect(loadSettings(discover())).rejects.toThrow(/50-broken\.json/);
    },
    T
  );

  it(
    "rejects a layer using the removed multi-project schema, naming the file",
    async () => {
      write("sous.config.json", JSON.stringify({ name: "ok" }));
      write("conf.d/50-legacy.json", JSON.stringify({ projects: { foo: {} }, defaultProject: "foo" }));

      await expect(loadSettings(discover())).rejects.toThrow(/50-legacy\.json/);
    },
    T
  );

  it(
    "validates the MERGED result, not individual fragments: an incomplete fragment " +
      "loads fine, but a conf.d layer that adds a typo key makes the merge invalid",
    async () => {
      // Primary is a complete, valid config. The conf.d fragment is NOT a valid
      // standalone config: compilation.targets is required, and this fragment omits
      // it — yet the load succeeds, because validation runs on the MERGED result
      // (which has targets from the primary), never on the fragment alone.
      const primary = write(
        "sous.config.json",
        JSON.stringify({
          name: "ok",
          compilation: { targets: [{ entryPoint: "a.md", outputs: [] }] },
        })
      );
      write("conf.d/10-frag.json", JSON.stringify({ compilation: { includeSourceComments: true } }));

      const settings = await loadSettings(discover());
      expect(settings.name).toBe("ok");
      expect(settings.compilation?.includeSourceComments).toBe(true);
      expect(settings.compilation?.targets).toHaveLength(1);

      // Now add a second conf.d layer with a typo key. Each fragment on its own is
      // fine, but the MERGED config carries the unknown key, so validation rejects
      // it through the real loadSettings with the readable, named message.
      write("conf.d/20-typo.json", JSON.stringify({ compilaton: {} }));

      await expect(loadSettings(discover())).rejects.toThrow(/compilaton/);
      await expect(loadSettings(discover())).rejects.toThrow(/typo/i);
      // The primary config file is named in the message, not the conf.d fragment.
      await expect(loadSettings(discover())).rejects.toThrow(
        new RegExp(primary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      );
    },
    T
  );

  it(
    "reports a .js configure() throw once, without the spurious tsx require-cycle artifact",
    async () => {
      // Regression: a `.js` (ESM) config that throws is imported fine by the node
      // attempt (which reports the real error) but the tsx fallback then fails to
      // re-import the same ESM `.js` with "Cannot require() ES Module … in a cycle"
      // (ERR_REQUIRE_CYCLE_MODULE). Because the two stderrs differ, the dedup did
      // not fire and BOTH were printed, burying the real error under scary noise.
      write("sous.config.js", `export function configure() { throw new Error("boom in configure"); }\n`);

      let message = "";
      try {
        await loadSettings(discover());
        throw new Error("expected loadSettings to reject");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toMatch(/boom in configure/);
      expect(message).not.toMatch(/cycle/i);
      expect(message).not.toMatch(/ERR_REQUIRE_CYCLE_MODULE/);
      // The real error is reported once, not duplicated across two [via ...] lines.
      expect(message).not.toMatch(/\[via /);
    },
    T
  );

  // --- trace mode -------------------------------------------------------------------------------

  it(
    "returns one cumulative snapshot per source when trace is enabled",
    async () => {
      const primary = write("sous.config.json", JSON.stringify({ _aliases: { order: ["primary"] } }));
      const a = write("conf.d/10-a.json", JSON.stringify({ _aliases: { order: ["a"] } }));
      const b = write("conf.d/20-b.json", JSON.stringify({ _aliases: { order: ["b"] } }));

      const { settings, layers } = await loadSettingsWithLayers(discover(), { trace: true });

      const order = (config: unknown) =>
        (config as { _aliases?: { order?: unknown } })._aliases?.order;
      expect(layers.map((l) => l.path)).toEqual([primary, a, b]);
      // Each snapshot is the CUMULATIVE config after that source merged.
      expect(order(layers[0].config)).toEqual(["primary"]);
      expect(order(layers[1].config)).toEqual(["primary", "a"]);
      expect(order(layers[2].config)).toEqual(["primary", "a", "b"]);
      expect(settings._aliases?.order).toEqual(["primary", "a", "b"]);
    },
    T
  );

  it(
    "returns no layer snapshots when trace is disabled",
    async () => {
      write("sous.config.json", JSON.stringify({ name: "x" }));

      const { layers } = await loadSettingsWithLayers(discover());
      expect(layers).toEqual([]);
    },
    T
  );

  // --- JSON forcing -----------------------------------------------------------------------------

  it(
    "drops functions and undefined values from a js layer (JSON forcing)",
    async () => {
      // Non-JSON values sit in schema-valid spots: `fn` is dropped before validation
      // (functions never survive the round-trip); `gone`/`when` live under _vars, a
      // record of strings once JSON-forced.
      write(
        "sous.config.mjs",
        `export const config = {
  name: "kept",
  fn: () => "should not survive",
  _vars: {
    gone: undefined,
    when: new Date("2020-01-01T00:00:00.000Z"),
  },
};
`
      );

      const settings = (await loadSettings(discover())) as Settings & Record<string, unknown>;
      expect(settings.name).toBe("kept");
      // Functions and undefined values are stripped by the JSON round-trip.
      expect("fn" in settings).toBe(false);
      expect("gone" in (settings._vars ?? {})).toBe(false);
      // A Date does not survive as a Date object; it serialises to an ISO string.
      expect(typeof settings._vars?.when).toBe("string");
      expect(settings._vars?.when).toBe("2020-01-01T00:00:00.000Z");
    },
    T
  );
});
