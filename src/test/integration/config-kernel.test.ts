import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { discoverConfig, type DiscoveredConfig } from "../../lib/config-discovery.js";
import { loadSettings, loadSettingsWithLayers } from "../../lib/settings.js";

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
      write("sous.config.json", JSON.stringify({ order: ["primary"] }));
      write("conf.d/10-a.json", JSON.stringify({ order: ["a"] }));
      write("conf.d/20-b.json", JSON.stringify({ order: ["b"] }));

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.order).toEqual(["primary", "a", "b"]);
    },
    T
  );

  it(
    "sorts conf.d bytewise, so '10-' loads before '2-'",
    async () => {
      write("sous.config.json", JSON.stringify({ order: ["primary"] }));
      write("conf.d/2-late.json", JSON.stringify({ order: ["two"] }));
      write("conf.d/10-early.json", JSON.stringify({ order: ["ten"] }));

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      // Bytewise (not numeric): "10-early" < "2-late".
      expect(settings.order).toEqual(["primary", "ten", "two"]);
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
      write(
        "sous.config.mjs",
        `export const config = { name: "seed" };
export function configure(cfg) { cfg.mutated = "yes"; cfg.sawName = cfg.name; }
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.mutated).toBe("yes");
      expect(settings.sawName).toBe("seed");
    },
    T
  );

  it(
    "merges the config object BEFORE running configure() when a file exports both",
    async () => {
      write(
        "sous.config.mjs",
        `export const config = { seed: "objval" };
export function configure(cfg) { cfg.readBack = cfg.seed + "-seen"; }
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      // Proof of ordering: configure could only read seed if the object merged first.
      expect(settings.seed).toBe("objval");
      expect(settings.readBack).toBe("objval-seen");
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
      write("sous.config.mjs", `export default (cfg) => { cfg.viaDefault = true; };\n`);

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.viaDefault).toBe(true);
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
  cfg.asyncField = v;
}
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.asyncField).toBe("async-value");
    },
    T
  );

  it(
    "merges a value returned from configure()",
    async () => {
      write(
        "sous.config.mjs",
        `export function configure() { return { returned: "merged-after" }; }\n`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.returned).toBe("merged-after");
    },
    T
  );

  // --- builder API ------------------------------------------------------------------------------

  it(
    "supports builder.merge()",
    async () => {
      write(
        "sous.config.mjs",
        `export function configure(cfg, builder) { builder.merge({ extra: "via-merge" }); }\n`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.extra).toBe("via-merge");
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
  cfg.present = builder.env("SOUS_KERNEL_TEST_VAR", "fallback");
  cfg.missing = builder.env("SOUS_KERNEL_DEFINITELY_UNSET", "fallback-used");
}
`
        );

        const settings = (await loadSettings(discover())) as Record<string, unknown>;
        expect(settings.present).toBe("from-env");
        expect(settings.missing).toBe("fallback-used");
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
      write("extra/rel.json", JSON.stringify({ fromRelative: true }));
      write("extra/abs.json", JSON.stringify({ fromAutoVar: true }));
      write(
        "sous.config.mjs",
        `export async function configure(cfg, builder) {
  await builder.loadConfig("./extra/rel.json");
  await builder.loadConfig("\${sousDir}/extra/abs.json");
}
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.fromRelative).toBe(true);
      expect(settings.fromAutoVar).toBe(true);
    },
    T
  );

  it(
    "supports builder.loadConfigs() globbing in bytewise order",
    async () => {
      write("parts/20-b.json", JSON.stringify({ order: ["b"] }));
      write("parts/10-a.json", JSON.stringify({ order: ["a"] }));
      write(
        "sous.config.mjs",
        `export async function configure(cfg, builder) {
  cfg.order = ["primary"];
  await builder.loadConfigs("\${sousDir}/parts/*.json");
}
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.order).toEqual(["primary", "a", "b"]);
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

  // --- trace mode -------------------------------------------------------------------------------

  it(
    "returns one cumulative snapshot per source when trace is enabled",
    async () => {
      const primary = write("sous.config.json", JSON.stringify({ order: ["primary"] }));
      const a = write("conf.d/10-a.json", JSON.stringify({ order: ["a"] }));
      const b = write("conf.d/20-b.json", JSON.stringify({ order: ["b"] }));

      const { settings, layers } = await loadSettingsWithLayers(discover(), { trace: true });

      expect(layers.map((l) => l.path)).toEqual([primary, a, b]);
      // Each snapshot is the CUMULATIVE config after that source merged.
      expect((layers[0].config as Record<string, unknown>).order).toEqual(["primary"]);
      expect((layers[1].config as Record<string, unknown>).order).toEqual(["primary", "a"]);
      expect((layers[2].config as Record<string, unknown>).order).toEqual(["primary", "a", "b"]);
      expect((settings as Record<string, unknown>).order).toEqual(["primary", "a", "b"]);
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
      write(
        "sous.config.mjs",
        `export const config = {
  name: "kept",
  fn: () => "should not survive",
  gone: undefined,
  when: new Date("2020-01-01T00:00:00.000Z"),
};
`
      );

      const settings = (await loadSettings(discover())) as Record<string, unknown>;
      expect(settings.name).toBe("kept");
      // Functions and undefined values are stripped by the JSON round-trip.
      expect("fn" in settings).toBe(false);
      expect("gone" in settings).toBe(false);
      // A Date does not survive as a Date object; it serialises to an ISO string.
      expect(typeof settings.when).toBe("string");
      expect(settings.when).toBe("2020-01-01T00:00:00.000Z");
    },
    T
  );
});
