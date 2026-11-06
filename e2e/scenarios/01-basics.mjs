import { assert, expectExit, expectIncludes, expectNotIncludes, parseJson, withoutTimingNoise } from "../lib/harness.mjs";

const NODE_WARNING = /\(node:\d+\) (Warning|\[MODULE_TYPELESS_PACKAGE_JSON\])|MODULE_TYPELESS_PACKAGE_JSON|ExperimentalWarning/;

export default {
  name: "basics",
  title: "Install, help, init, build, compile, prune, clear",
  async run(t) {
    await t.step("--version prints the installed version on stdout", () => {
      const r = expectExit(t.sous(["--version"]));
      assert.match(r.stdout.trim(), /^v?\d+\.\d+\.\d+/);
      assert.equal(r.stderr, "");
      expectIncludes(r.stdout, t.requestedVersion, "version output");
    });

    await t.step("`sous version` agrees with --version", () => {
      const a = expectExit(t.sous(["version"])).stdout.trim();
      const b = expectExit(t.sous(["--version"])).stdout.trim();
      assert.equal(a, b);
    });

    await t.step("--help lists the commands on stdout", () => {
      const r = expectExit(t.sous(["--help"]));
      for (const word of ["build", "init", "config", "subscription", "repo", "mcp"]) expectIncludes(r.stdout, word, "help");
    });

    await t.step("a command's --help describes its flags", () => {
      const r = expectExit(t.sous(["build", "--help"]));
      for (const flag of ["--dry-run", "--rebuild", "--strict"]) expectIncludes(r.stdout, flag, "build --help");
    });

    await t.step("an unknown command fails with a message on stderr only", () => {
      const r = t.sous(["no-such-command"]);
      assert.notEqual(r.code, 0);
      assert.equal(r.stdout.trim(), "");
      assert.ok(r.stderr.length > 0);
    });

    await t.step("completion prints a script for bash, zsh and fish", () => {
      for (const shell of ["bash", "zsh", "fish"]) {
        const r = expectExit(t.sous(["completion", shell]));
        assert.ok(r.stdout.length > 100, `${shell} script is empty`);
      }
    });

    t.project();

    await t.step("init --dry-run lists files and writes nothing", () => {
      const r = expectExit(t.sous(["init", "--dry-run"]));
      assert.equal(t.exists(".sous"), false);
      expectIncludes(r.stdout + r.stderr, "sous.config.js", "init --dry-run");
    });

    await t.step("init writes .sous/ with the config, the AGENTS.md source and the first build", () => {
      const r = expectExit(t.sous(["init"]));
      for (const file of [
        ".sous/sous.config.js",
        ".sous/memories/AGENTS.tpl.md",
        ".sous/.env",
        ".sous/.env.local.example",
        ".sous/.gitignore",
        ".sous/README.md",
        ".sous/CLAUDE.md",
        ".sous/conf.d/README.md",
        "AGENTS.md",
        ".sous/sous.lock.json",
      ]) assert.ok(t.exists(file), `missing ${file}`);
      assert.ok(t.exists(".claude/skills/about-sous/SKILL.md"), "core skills were not written");
      expectNotIncludes(r.stderr, "does not load", "init stderr");
    });

    await t.step("init writes a .gitignore that keeps machine-local state out of git", () => {
      const ignore = t.read(".sous/.gitignore");
      for (const entry of [".env.local", "sous.state.json"]) expectIncludes(ignore, entry, ".sous/.gitignore");
    });

    await t.step("no Node warning appears on stderr of a plain build", () => {
      const r = expectExit(t.sous(["build"]));
      assert.doesNotMatch(r.stderr, NODE_WARNING);
    });

    await t.step("a second build reports every output unchanged and rewrites nothing", () => {
      const before = t.sh("find . -path ./node_modules -prune -o -type f -newer .sous/sous.config.js -print | sort").stdout;
      const r = expectExit(t.sous(["build"]));
      const text = r.stderr + r.stdout;
      expectIncludes(text, "(unchanged)", "second build");
      expectNotIncludes(text, "✓ /", "second build wrote a file");
      void before;
    });

    await t.step("a build that writes an output shows its size as (~N tokens)", () => {
      t.sh("rm -f AGENTS.md");
      const r = expectExit(t.sous(["build"]));
      assert.match(r.stderr + r.stdout, /✓ \S*AGENTS\.md \(~\d+ tokens\)/);
    });

    await t.step("build --json prints exactly one JSON object on stdout", () => {
      const r = expectExit(t.sous(["--json", "build"]));
      const json = parseJson(r.stdout);
      assert.equal(json.ok, true);
      assert.ok(Array.isArray(json.compiled.outputs));
    });

    await t.step("build --dry-run changes no file", () => {
      t.write("AGENTS.md", "hand edited\n");
      const r = expectExit(t.sous(["build", "--dry-run"]));
      assert.equal(t.read("AGENTS.md"), "hand edited\n");
      expectIncludes(r.stdout + r.stderr, "AGENTS.md", "dry-run");
      expectExit(t.sous(["build", "--rebuild"]));
      expectNotIncludes(t.read("AGENTS.md"), "hand edited", "AGENTS.md after build --rebuild");
    });

    await t.step("compile writes the outputs without preparing recipes", () => {
      t.sh("rm -f AGENTS.md");
      expectExit(t.sous(["compile"]));
      assert.ok(t.exists("AGENTS.md"));
    });

    await t.step("compile --dry-run writes nothing", () => {
      t.sh("rm -f AGENTS.md");
      expectExit(t.sous(["compile", "--dry-run"]));
      assert.equal(t.exists("AGENTS.md"), false);
      expectExit(t.sous(["compile"]));
    });

    await t.step("prune --dry-run with nothing stale says so", () => {
      const r = expectExit(t.sous(["prune", "--dry-run"]));
      expectIncludes(withoutTimingNoise(r.stderr + r.stdout), "Nothing to remove", "prune --dry-run");
    });

    await t.step("prune removes an output the config no longer produces", () => {
      // Remove the starter target; its AGENTS.md is then stale.
      const cfg = t.read(".sous/sous.config.js");
      t.write(".sous/sous.config.js", cfg.replace(/compilation: \{[\s\S]*?\n  \},\n/, ""));
      const dry = expectExit(t.sous(["prune", "--dry-run"]));
      expectIncludes(dry.stderr + dry.stdout, "AGENTS.md", "prune --dry-run");
      assert.ok(t.exists("AGENTS.md"), "dry run deleted the file");
      expectExit(t.sous(["prune"]));
      assert.equal(t.exists("AGENTS.md"), false);
      t.write(".sous/sous.config.js", cfg);
      expectExit(t.sous(["build"]));
    });

    await t.step("clear --dry-run lists files and removes none", () => {
      const r = expectExit(t.sous(["clear", "--dry-run"]));
      expectIncludes(r.stderr + r.stdout, "Would remove", "clear --dry-run");
      assert.ok(t.exists("AGENTS.md"));
    });

    await t.step("clear --yes removes the written files and keeps .sous/", () => {
      expectExit(t.sous(["clear", "--yes"]));
      assert.equal(t.exists("AGENTS.md"), false);
      assert.ok(t.exists(".sous/sous.config.js"));
    });

    await t.step("clear without --force and without a terminal fails naming --force", () => {
      expectExit(t.sous(["build"]));
      const r = t.sous(["clear"]);
      assert.notEqual(r.code, 0);
      // --force is the flag's name; --yes is another name for it.
      expectIncludes(r.stderr, "--force", "clear stderr");
      assert.ok(t.exists("AGENTS.md"));
    });

    await t.step("init in a package.json with \"type\": \"commonjs\" writes a config that loads", () => {
      const dir = t.project({ name: "cjs-proj", packageJson: { type: "commonjs" } });
      const r = t.sous(["init"], { cwd: dir });
      expectExit(r);
      assert.doesNotMatch(r.stderr, NODE_WARNING);
      expectNotIncludes(r.stderr, "does not load", "init stderr");
    });

    await t.step("init in a package.json with \"type\": \"module\" writes a config that loads", () => {
      const dir = t.project({ name: "esm-proj", packageJson: { type: "module" } });
      const r = t.sous(["init"], { cwd: dir });
      expectExit(r);
      assert.doesNotMatch(r.stderr, NODE_WARNING);
    });
  },
};
