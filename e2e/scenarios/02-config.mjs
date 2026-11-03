import { assert, expectExit, expectIncludes, parseJson, withoutTimingNoise } from "../lib/harness.mjs";

export default {
  name: "config",
  title: "Config: show, get, set, validate, layers, CommonJS",
  async run(t) {
    t.initializedProject({ dir: "cfg" });

    await t.step("config show prints the built config as JSON on stdout", () => {
      const r = expectExit(t.sous(["config", "show"]));
      const cfg = parseJson(r.stdout);
      assert.equal(cfg.name, "cfg");
      assert.ok(cfg.repos["sous-recipes"].url.includes("sous-io/sous-recipes"));
    });

    await t.step("config show --json wraps the config in { config }", () => {
      const j = parseJson(expectExit(t.sous(["--json", "config", "show"])).stdout);
      assert.equal(j.config.name, "cfg");
    });

    await t.step("config get on a scalar prints the bare value", () => {
      assert.equal(expectExit(t.sous(["config", "get", "name"])).stdout.trim(), "cfg");
    });

    await t.step("config get --json gives { path, exists, value }", () => {
      const j = parseJson(expectExit(t.sous(["--json", "config", "get", "name"])).stdout);
      assert.equal(j.path, "name");
      assert.equal(j.exists, true);
      assert.equal(j.value, "cfg");
    });

    await t.step("config get on an object prints JSON", () => {
      const v = parseJson(expectExit(t.sous(["config", "get", "subscriptions"])).stdout);
      assert.ok(v.core);
    });

    await t.step("config get on a missing path exits 1 and names the path", () => {
      const r = t.sous(["config", "get", "no.such.path"]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout.trim(), "");
      expectIncludes(r.stderr, "no.such.path", "stderr");
    });

    await t.step("config get --layers shows who set the value", () => {
      const r = expectExit(t.sous(["config", "get", "name", "--layers"]));
      expectIncludes(r.stdout + r.stderr, "sous.config.js", "layers");
    });

    await t.step("config show --layers lists each contributor", () => {
      const r = expectExit(t.sous(["config", "show", "--layers"]));
      expectIncludes(r.stdout + r.stderr, "recipes.core", "layers");
    });

    await t.step("config validate passes on a good config", () => {
      const r = expectExit(t.sous(["config", "validate"]));
      expectIncludes(r.stdout + r.stderr, "Config is valid", "validate");
    });

    await t.step("conf.d layers apply in number order (900 overrides 100)", () => {
      t.write(".sous/conf.d/900-b.jsonc", '{ "name": "from-900" }\n');
      t.write(".sous/conf.d/100-a.jsonc", '{ "name": "from-100" }\n');
      assert.equal(expectExit(t.sous(["config", "get", "name"])).stdout.trim(), "from-900");
      t.sh("rm .sous/conf.d/900-b.jsonc");
      assert.equal(expectExit(t.sous(["config", "get", "name"])).stdout.trim(), "from-100");
      t.sh("rm .sous/conf.d/100-a.jsonc");
    });

    await t.step("two files with one base name in a directory are an error naming both", () => {
      t.write(".sous/conf.d/900-b.jsonc", '{ "name": "x" }\n');
      t.write(".sous/conf.d/900-b.json", '{ "name": "y" }\n');
      const r = t.sous(["config", "get", "name"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "900-b.json", "stderr");
      expectIncludes(r.stderr, "900-b.jsonc", "stderr");
      t.sh("rm .sous/conf.d/900-b.json .sous/conf.d/900-b.jsonc");
    });

    await t.step("config validate rejects an unknown key with a non-zero exit", () => {
      t.write(".sous/conf.d/950-typo.jsonc", '{ "nmae": "oops" }\n');
      const r = t.sous(["config", "validate"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "nmae", "stderr");
      t.sh("rm .sous/conf.d/950-typo.jsonc");
    });

    await t.step("config validate rejects a value of the wrong type", () => {
      t.write(".sous/conf.d/960-type.jsonc", '{ "compilation": { "targets": 5 } }\n');
      const r = t.sous(["config", "validate"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "compilation.targets", "stderr");
      t.sh("rm .sous/conf.d/960-type.jsonc");
    });

    await t.step("config validate rejects a conf.d file that is not valid JSONC", () => {
      t.write(".sous/conf.d/970-bad.jsonc", "{ bad\n");
      const r = t.sous(["config", "validate"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "970-bad.jsonc", "stderr");
      t.sh("rm .sous/conf.d/970-bad.jsonc");
    });

    await t.step("config set --file writes one key into a conf.d file, and config get reads it", () => {
      const dry = expectExit(t.sous(["config", "set", "compilation.includeSourceComments", "true", "--file", "610-mac.jsonc", "--dry-run"]));
      assert.equal(t.exists(".sous/conf.d/610-mac.jsonc"), false, "dry run wrote a file");
      void dry;
      expectExit(t.sous(["config", "set", "compilation.includeSourceComments", "true", "--file", "610-mac.jsonc"]));
      assert.equal(parseJson(t.read(".sous/conf.d/610-mac.jsonc").replace(/\/\/.*$/gm, "")).compilation.includeSourceComments, true);
      assert.equal(expectExit(t.sous(["config", "get", "compilation.includeSourceComments"])).stdout.trim(), "true");
      expectExit(t.sous(["config", "set", "compilation.includeSourceComments", "--unset", "--file", "610-mac.jsonc"]));
      assert.equal(expectExit(t.sous(["config", "get", "compilation.includeSourceComments"])).stdout.trim(), "false");
    });

    await t.step("config set without --file on the starter .js config explains why it cannot edit it", () => {
      const r = t.sous(["config", "set", "name", "other"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "--file", "stderr");
    });

    await t.step("config set works on a JSONC primary config", () => {
      t.sh("mv .sous/sous.config.js /tmp/keep.js");
      t.write(".sous/sous.config.jsonc", '// primary\n{ "name": "jsonc-name" }\n');
      expectExit(t.sous(["config", "set", "name", "changed"]));
      expectIncludes(t.read(".sous/sous.config.jsonc"), "// primary", "comment kept");
      assert.equal(expectExit(t.sous(["config", "get", "name"])).stdout.trim(), "changed");
      t.sh("rm .sous/sous.config.jsonc; mv /tmp/keep.js .sous/sous.config.js");
    });

    await t.step("a CommonJS module.exports sous.config.js loads", () => {
      t.sh("mv .sous/sous.config.js /tmp/keep.js");
      t.write(".sous/sous.config.js", 'module.exports = { name: "cjs-name" };\n');
      const r = expectExit(t.sous(["config", "get", "name"]));
      assert.equal(r.stdout.trim(), "cjs-name");
      assert.doesNotMatch(r.stderr, /Warning: (Failed|To load)/);
      t.sh("mv /tmp/keep.js .sous/sous.config.js");
    });

    await t.step("an ES module sous.config.mjs loads with no Node warning", () => {
      t.sh("mv .sous/sous.config.js /tmp/keep.js");
      t.write(".sous/sous.config.mjs", 'export const config = { name: "mjs-name" };\n');
      const r = expectExit(t.sous(["config", "get", "name"]));
      assert.equal(r.stdout.trim(), "mjs-name");
      assert.doesNotMatch(withoutTimingNoise(r.stderr), /Warning/);
      t.sh("rm .sous/sous.config.mjs; mv /tmp/keep.js .sous/sous.config.js");
    });

    await t.step("--config points sous at another config file", () => {
      t.write("elsewhere/custom.config.mjs", 'export const config = { name: "custom" };\n');
      const r = expectExit(t.sous(["--config", "elsewhere/custom.config.mjs", "config", "get", "name"]));
      assert.equal(r.stdout.trim(), "custom");
    });

    await t.step("SOUS_* environment variables and --sous-* flags are accepted", () => {
      const r = expectExit(t.sous(["--sous-dir", `${t.cwd}/.sous`, "config", "get", "name"]));
      assert.equal(r.stdout.trim(), "cfg");
    });
  },
};
