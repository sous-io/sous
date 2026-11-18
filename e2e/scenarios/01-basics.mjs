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

    // The output every build writes here: a core skill, through the Claude Code plugin.
    const SKILL = ".claude/skills/about-sous/SKILL.md";

    await t.step("init --dry-run lists files and writes nothing", () => {
      const r = expectExit(t.sous(["init", "--dry-run"]));
      assert.equal(t.exists(".sous"), false);
      assert.equal(t.exists(".husky"), false);
      expectIncludes(r.stdout + r.stderr, "sous.config.jsonc", "init --dry-run");
    });

    await t.step("init without a terminal, in a git repository, fails naming the hook flags", () => {
      const r = t.sous(["init"]);
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "--no-hooks", "init stderr");
      assert.equal(t.exists(".sous"), false);
    });

    await t.step("init writes .sous/ with the config, the memories source and the first build", () => {
      const r = expectExit(t.sous(["init", "--no-hooks"]));
      for (const file of [
        ".sous/sous.config.jsonc",
        ".sous/MEMORIES.tpl.md",
        ".sous/memories/project.tpl.md",
        ".sous/.env",
        ".sous/.env.local.example",
        ".sous/.gitignore",
        ".sous/README.md",
        ".sous/CLAUDE.md",
        ".sous/conf.d/README.md",
        ".sous/sous.lock.json",
      ]) assert.ok(t.exists(file), `missing ${file}`);
      for (const file of [".sous/sous.config.js", "AGENTS.md", ".husky"]) assert.equal(t.exists(file), false, `unexpected ${file}`);
      assert.ok(t.exists(SKILL), "core skills were not written");
      expectNotIncludes(r.stderr, "does not load", "init stderr");
      assert.match(t.read(".sous/MEMORIES.tpl.md"), /\n@memories\/\*\*\/\*\.md\n@#memories\/\*\*\/\*\.md\n$/);
      assert.ok(JSON.parse(t.read(".sous/sous.lock.json")).migratedVersion, "migratedVersion was not written");
    });

    await t.step("init writes a .gitignore that keeps machine-local state out of git", () => {
      const ignore = t.read(".sous/.gitignore");
      for (const entry of [".env.local", "sous.state.json", "backups/"]) expectIncludes(ignore, entry, ".sous/.gitignore");
    });

    await t.step("init gitignores the build output at the project root", () => {
      const ignore = t.read(".gitignore");
      for (const entry of ["/.claude/rules/SOUS-MEMORIES.md", "/.claude/skills/", "/.claude/agents/", "/AGENTS.override.md"]) expectIncludes(ignore, entry, ".gitignore");
      expectNotIncludes(ignore, "/AGENTS.md", ".gitignore");
    });

    await t.step("no Node warning appears on stderr of a plain build", () => {
      const r = expectExit(t.sous(["build"]));
      assert.doesNotMatch(r.stderr, NODE_WARNING);
    });

    await t.step("a second build reports every output unchanged and rewrites nothing", () => {
      const before = t.sh("find . -path ./node_modules -prune -o -type f -newer .sous/sous.config.jsonc -print | sort").stdout;
      const r = expectExit(t.sous(["build"]));
      const text = r.stderr + r.stdout;
      expectIncludes(text, "(unchanged)", "second build");
      expectNotIncludes(text, "✓ /", "second build wrote a file");
      void before;
    });

    await t.step("a build that writes an output shows its size as (~N tokens)", () => {
      t.sh(`rm -f ${SKILL}`);
      const r = expectExit(t.sous(["build"]));
      // The count is grouped by thousands: "(~1,827 tokens)".
      assert.match(r.stderr + r.stdout, /✓ \S*about-sous\/SKILL\.md \(~[\d,]+ tokens\)/);
    });

    await t.step("build --json prints exactly one JSON object on stdout", () => {
      const r = expectExit(t.sous(["--json", "build"]));
      const json = parseJson(r.stdout);
      assert.equal(json.ok, true);
      assert.ok(Array.isArray(json.compiled.outputs));
    });

    await t.step("build --dry-run changes no file", () => {
      t.write(SKILL, "hand edited\n");
      const r = expectExit(t.sous(["build", "--dry-run"]));
      assert.equal(t.read(SKILL), "hand edited\n");
      expectIncludes(r.stdout + r.stderr, "about-sous/SKILL.md", "dry-run");
      expectExit(t.sous(["build", "--rebuild"]));
      expectNotIncludes(t.read(SKILL), "hand edited", "SKILL.md after build --rebuild");
    });

    await t.step("compile writes the outputs without preparing recipes", () => {
      t.sh(`rm -f ${SKILL}`);
      expectExit(t.sous(["compile"]));
      assert.ok(t.exists(SKILL));
    });

    await t.step("compile --dry-run writes nothing", () => {
      t.sh(`rm -f ${SKILL}`);
      expectExit(t.sous(["compile", "--dry-run"]));
      assert.equal(t.exists(SKILL), false);
      expectExit(t.sous(["compile"]));
    });

    await t.step("prune --dry-run with nothing stale says so", () => {
      const r = expectExit(t.sous(["prune", "--dry-run"]));
      expectIncludes(withoutTimingNoise(r.stderr + r.stdout), "Nothing to remove", "prune --dry-run");
    });

    // A project skill, which the config's one target compiles into .claude/skills/demo/.
    const DEMO = ".claude/skills/demo/SKILL.md";

    await t.step("prune removes an output the config no longer produces", () => {
      t.write(".sous/skills/demo/SKILL.md", "---\nname: demo\ndescription: A demo skill.\n---\n\nDemo.\n");
      expectExit(t.sous(["build"]));
      assert.ok(t.exists(DEMO), "the project skill was not compiled");
      // Remove the project-skills target; its output is then stale.
      const cfg = t.read(".sous/sous.config.jsonc");
      t.write(".sous/sous.config.jsonc", cfg.replace(/"compilation": \{[\s\S]*?\n  \}\n/, '"compilation": { "targets": [] }\n'));
      const dry = expectExit(t.sous(["prune", "--dry-run"]));
      expectIncludes(dry.stderr + dry.stdout, "demo/SKILL.md", "prune --dry-run");
      assert.ok(t.exists(DEMO), "dry run deleted the file");
      expectExit(t.sous(["prune"]));
      assert.equal(t.exists(DEMO), false);
      t.write(".sous/sous.config.jsonc", cfg);
      expectExit(t.sous(["build"]));
    });

    await t.step("clear --dry-run lists files and removes none", () => {
      const r = expectExit(t.sous(["clear", "--dry-run"]));
      expectIncludes(r.stderr + r.stdout, "Would remove", "clear --dry-run");
      assert.ok(t.exists(SKILL));
    });

    await t.step("clear --yes removes the written files and keeps .sous/", () => {
      expectExit(t.sous(["clear", "--yes"]));
      assert.equal(t.exists(SKILL), false);
      assert.ok(t.exists(".sous/sous.config.jsonc"));
    });

    await t.step("clear without --force and without a terminal fails naming --force", () => {
      expectExit(t.sous(["build"]));
      const r = t.sous(["clear"]);
      assert.notEqual(r.code, 0);
      // --force is the flag's name; --yes is another name for it.
      expectIncludes(r.stderr, "--force", "clear stderr");
      assert.ok(t.exists(SKILL));
    });

    await t.step("init in a package.json with \"type\": \"commonjs\" writes a config that loads", () => {
      const dir = t.project({ name: "cjs-proj", packageJson: { type: "commonjs" } });
      const r = t.sous(["init", "--no-hooks"], { cwd: dir });
      expectExit(r);
      assert.doesNotMatch(r.stderr, NODE_WARNING);
      expectNotIncludes(r.stderr, "does not load", "init stderr");
    });

    await t.step("init in a package.json with \"type\": \"module\" writes a config that loads", () => {
      const dir = t.project({ name: "esm-proj", packageJson: { type: "module" } });
      const r = t.sous(["init", "--no-hooks"], { cwd: dir });
      expectExit(r);
      assert.doesNotMatch(r.stderr, NODE_WARNING);
    });

    await t.step("init --hooks --no-install sets up Husky, the prepare script and post-checkout", () => {
      const dir = t.project({ name: "hooked-proj", packageJson: { scripts: { prepare: "echo before" } } });
      expectExit(t.sous(["init", "--hooks", "--no-pull-hooks", "--no-install", "--no-build"], { cwd: dir }));
      const pkg = JSON.parse(t.read("package.json", dir));
      assert.equal(pkg.scripts.prepare, "echo before && (husky && sous build || exit 0)");
      assert.ok(pkg.devDependencies.husky, "husky was not added");
      const hook = t.read(".husky/post-checkout", dir);
      expectIncludes(hook, "# >>> sous managed: init hooks", ".husky/post-checkout");
      expectIncludes(hook, "npm install || echo", ".husky/post-checkout");
      assert.equal(t.exists(".husky/post-merge", dir), false);
    });

    await t.step("without a package.json, the post-checkout hook builds a new worktree", () => {
      const dir = `${t.root}/plain-proj`;
      // The image points every repository's hooks at the read-only /e2e/hooks (the push allowlist);
      // this project never pushes, so it gets git's own hooks folder back for sous to write in.
      t.sh(`mkdir -p ${dir} && cd ${dir} && git init -q && git config user.email e2e@example.test && git config user.name e2e && git config core.hooksPath ${dir}/.git/hooks`);
      expectExit(t.sous(["init", "--yes"], { cwd: dir }));
      assert.ok(t.exists(".git/hooks/post-checkout", dir), "the hook was not written");
      // `t.sh` runs a login shell, which resets PATH; the hook finds `sous` only on the PATH sous runs with.
      const added = t.sh(`export PATH="${process.env.PATH}" && git add -A && git commit -qm init && git worktree add -q ../plain-proj-wt`, { cwd: dir });
      assert.ok(t.exists(`${t.root}/plain-proj-wt/${SKILL}`), `the hook did not build the new worktree:\n${added.stdout}\n${added.stderr}`);
    });
  },
};
