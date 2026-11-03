import path from "node:path";
import { assert, expectExit, expectIncludes, parseJson } from "../lib/harness.mjs";

const PLUGIN = `
import { definePlugin, IntentOutput, IntentOutputs, VariableSet, jsonSchema } from "@sous-io/plugin-api";

export default definePlugin({
  name: "e2e-hello-plugin",
  version: "1.2.3",
  register(sous) {
    sous.intents.add({
      intent: "hello.greet",
      summary: "Greet someone from an outside plugin",
      input: jsonSchema({
        type: "object",
        properties: { who: { type: "string", description: "Who to greet." } },
      }),
      cli: { positional: ["who"], examples: ["sous hello greet world"] },
      async handle(input, ctx) {
        ctx.reporter.info("greeting in progress");
        const who = input.who ?? "nobody";
        return new IntentOutputs(
          new IntentOutput({ title: "Greeting", result: new VariableSet({ Greeting: "hello " + who }), data: { greeting: "hello " + who } }),
        );
      },
    });
  },
});
`;

export default {
  name: "plugins",
  title: "Plugins: built-ins, an outside plugin that adds a command, plugin install dry run",
  async run(t) {
    const project = t.initializedProject({ dir: "plug" });

    await t.step("plugins show lists the built-in plugins", () => {
      const r = expectExit(t.sous(["plugins", "show"]));
      const text = r.stdout + r.stderr;
      for (const name of ["@sous-io/plugin-recipes", "@sous-io/plugin-compiler", "@sous-io/plugin-cli"]) expectIncludes(text, name, "plugins show");
    });

    await t.step("plugins show <name> shows one plugin at the running version", () => {
      const r = expectExit(t.sous(["plugins", "show", "@sous-io/plugin-git"]));
      expectIncludes(r.stdout + r.stderr, "@sous-io/plugin-git", "plugins show");
      expectIncludes(r.stdout + r.stderr, t.sousVersion.replace(/^v/, ""), "plugins show version");
    });

    await t.step("plugins show --json is one object", () => {
      parseJson(expectExit(t.sous(["--json", "plugins", "show"])).stdout);
    });

    await t.step("plugins install --dry-run shows the package manager command and installs nothing", () => {
      const r = expectExit(t.sous(["plugins", "install", "sous-plugin-claude-code", "--dry-run"]));
      expectIncludes(r.stdout + r.stderr, "npm", "dry run");
      assert.equal(t.exists("node_modules/sous-plugin-claude-code"), false);
    });

    const dir = path.join(t.root, "e2e-plugin");
    t.write("package.json", JSON.stringify({ name: "e2e-hello-plugin", version: "1.2.3", type: "module", main: "index.mjs" }), dir);
    t.write("index.mjs", PLUGIN, dir);
    await t.step("an outside plugin can be installed next to its plugin-api", () => {
      const sousVersion = t.sousVersion.replace(/^v/, "");
      expectExit(t.sh(`npm i --no-audit --no-fund @sous-io/plugin-api@${sousVersion}`, { cwd: dir, timeout: 240_000 }));
    });

    await t.step("plugins.load in a conf.d file loads the plugin", () => {
      t.write(".sous/conf.d/700-plugins.jsonc", JSON.stringify({ plugins: { load: [path.join(dir, "index.mjs")] } }), project);
      const r = expectExit(t.sous(["plugins", "show", "e2e-hello-plugin"], { cwd: project }));
      expectIncludes(r.stdout + r.stderr, "hello.greet", "plugins show");
    });

    await t.step("the plugin's intent is a command with its own help", () => {
      const r = expectExit(t.sous(["hello", "greet", "--help"], { cwd: project }));
      expectIncludes(r.stdout, "Greet someone from an outside plugin", "help");
    });

    await t.step("the command prints its result on stdout and progress on stderr", () => {
      const r = expectExit(t.sous(["hello", "greet", "world"], { cwd: project }));
      expectIncludes(r.stdout, "hello world", "stdout");
      assert.ok(!r.stdout.includes("greeting in progress"), "progress leaked to stdout");
      expectIncludes(r.stderr, "greeting in progress", "stderr");
    });

    await t.step("under --json the command prints one object on stdout", () => {
      const r = expectExit(t.sous(["--json", "hello", "greet", "world"], { cwd: project }));
      const j = parseJson(r.stdout);
      assert.ok(JSON.stringify(j).includes("hello world"), r.stdout);
    });

    await t.step("shell completion offers the plugin's command", () => {
      const r = expectExit(t.sous(["__complete", "he"], { cwd: project }));
      expectIncludes(r.stdout, "hello", "completion");
    });

    await t.step("plugins.disabled stops the plugin from loading", () => {
      t.write(".sous/conf.d/701-disabled.jsonc", JSON.stringify({ plugins: { disabled: ["e2e-hello-plugin"] } }), project);
      const r = t.sous(["hello", "greet", "world"], { cwd: project });
      assert.notEqual(r.code, 0);
      t.sh("rm .sous/conf.d/701-disabled.jsonc", { cwd: project });
    });

    await t.step("a plugin path that does not exist is an error that names it", () => {
      t.write(".sous/conf.d/702-missing.jsonc", JSON.stringify({ plugins: { load: ["/no/such/plugin.mjs"] } }), project);
      const r = t.sous(["config", "validate"], { cwd: project });
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "/no/such/plugin.mjs", "stderr");
      t.sh("rm .sous/conf.d/702-missing.jsonc", { cwd: project });
    });

    await t.step("a recipe that ships a sous plugin adds its command once the repository is trusted", () => {
      const repo = path.join(t.root, "plugin-recipes");
      t.sh(`git init -q ${repo}`);
      expectExit(t.sous(["repo", "init", repo, "--name", "plugrepo", "--namespace", "plug"], { cwd: t.root }));
      const manifestPath = "recipes/plug/example/sous.recipe.yaml";
      t.write(manifestPath, t.read(manifestPath, repo).replace(/^contents:/m, "plugin:\n  bundle: plugin/index.js\n\ncontents:"), repo);
      t.write(
        "recipes/plug/example/plugin/index.js",
        `export default { name: "recipe-shipped-plugin", version: "0.0.1", register(sous) { sous.intents.add({ intent: "recipeplug.hi", summary: "Say hi from a recipe plugin", handle: async (input, ctx) => ctx.run("config.get", { path: "name" }) }); } };\n`,
        repo,
      );
      t.sh("git add -A && git commit -qm scaffold", { cwd: repo });
      const rel = t.sous(["repo", "release", "--yes"], { cwd: repo });
      assert.equal(rel.code, 0, rel.stderr + rel.stdout);
      const p = t.initializedProject({ dir: "plug-consumer" });
      expectExit(t.sous(["repo", "add", repo, "--yes"], { cwd: p }));
      const sub = t.sous(["subscription", "add", "plug/example", "--yes"], { cwd: p });
      assert.equal(sub.code, 0, sub.stderr + sub.stdout);
      const hi = t.sous(["recipeplug", "hi"], { cwd: p });
      assert.equal(hi.code, 0, hi.stderr + hi.stdout);
      expectIncludes(hi.stdout, "plug-consumer", "stdout (the plugin ran config.get through ctx.run)");
    });

    await t.step("a recipe plugin from a repository that is not trusted does not run", () => {
      const p = t.initializedProject({ dir: "plug-untrusted" });
      const r = t.sous(["recipeplug", "hi"], { cwd: p });
      assert.notEqual(r.code, 0);
    });
  },
};
