// Authoring a recipe repository, publishing it to the four allowlisted test repositories,
// consuming it from a project, and proposing a change back (pull request / merge request).

import fs from "node:fs";
import path from "node:path";
import { assert, expectExit, expectIncludes, parseJson, RUN_ID, run } from "../lib/harness.mjs";
import { WRITABLE_REPOSITORIES, assertWritable } from "../lib/allowlist.mjs";

const TARGETS = [
  { id: "public-github", url: "https://github.com/sous-io/public-github-test-repo", kind: "github", private: false },
  { id: "private-github", url: "https://github.com/sous-io/private-github-test-repo", kind: "github", private: true },
  { id: "public-gitlab", url: "https://gitlab.com/sous-io/public-gitlab-test-repo", kind: "gitlab", private: false },
  { id: "private-gitlab", url: "https://gitlab.com/sous-io/Test-Repo", kind: "gitlab", private: true },
];

const slug = RUN_ID.toLowerCase().replace(/[^a-z0-9]/g, "");

export default {
  name: "authoring",
  title: "Authoring: repo init, release, publish to test repositories, repo add, submit",
  async run(t) {
    await t.step("the safety allowlist holds exactly the four test repositories", () => {
      assert.equal(WRITABLE_REPOSITORIES.length, 4);
      assert.throws(() => assertWritable("https://github.com/sous-io/sous-recipes"), /SAFETY/);
      assert.throws(() => assertWritable("git@github.com:sous-io/sous.git"), /SAFETY/);
      assert.doesNotThrow(() => assertWritable("https://github.com/sous-io/public-github-test-repo.git"));
    });

    // ---- local authoring ----
    const local = path.join(t.root, "local-recipes");
    await t.step("repo init --dry-run lists the files and writes nothing", () => {
      const r = expectExit(t.sous(["repo", "init", local, "--name", "e2e-local", "--namespace", "e2e", "--dry-run"], { cwd: t.root }));
      assert.equal(fs.existsSync(local), false);
      expectIncludes(r.stderr + r.stdout, "sous.repo.yaml", "repo init --dry-run");
    });

    await t.step("repo init writes a repository scaffold with an example recipe", () => {
      t.sh(`git init -q ${local}`);
      expectExit(t.sous(["repo", "init", local, "--name", "e2e-local", "--namespace", "e2e"], { cwd: t.root }));
      for (const f of ["sous.repo.yaml", "sous.index.json", "recipes/e2e/example/sous.recipe.yaml", "recipes/e2e/example/skills/example-skill/SKILL.tpl.md", "README.md"]) {
        assert.ok(fs.existsSync(path.join(local, f)), `missing ${f}`);
      }
    });

    await t.step("repo release --check passes on a fresh scaffold", () => {
      t.sh("git add -A && git commit -qm scaffold", { cwd: local });
      expectExit(t.sous(["repo", "release", "--check"], { cwd: local }));
    });

    await t.step("repo release --dry-run prints its plan on stdout or stderr and changes nothing", () => {
      const before = t.sh("git rev-parse HEAD", { cwd: local }).stdout;
      const r = expectExit(t.sous(["repo", "release", "--dry-run"], { cwd: local }));
      expectIncludes(r.stderr + r.stdout, "e2e/example", "release plan");
      expectIncludes(r.stderr + r.stdout, "0.1.0", "release plan");
      assert.equal(t.sh("git rev-parse HEAD", { cwd: local }).stdout, before);
      assert.equal(t.sh("git tag", { cwd: local }).stdout.trim(), "");
    });

    await t.step("repo release --dry-run --json prints one object with the plan", () => {
      const j = parseJson(expectExit(t.sous(["--json", "repo", "release", "--dry-run"], { cwd: local })).stdout);
      assert.equal(j.dryRun, true);
      assert.equal(j.plan[0].key, "e2e/example");
    });

    await t.step("repo release --yes commits the index and tags the version", () => {
      expectExit(t.sous(["repo", "release", "--yes"], { cwd: local }));
      assert.equal(t.sh("git tag", { cwd: local }).stdout.trim(), "e2e/example@0.1.0");
    });

    await t.step("a project can repo add the local repository, subscribe and build its skill", () => {
      const p = t.initializedProject({ dir: "consumer-local" });
      expectExit(t.sous(["repo", "add", local, "--yes"], { cwd: p }));
      expectExit(t.sous(["subscription", "add", "e2e/example", "--yes"], { cwd: p }));
      assert.ok(t.exists(".claude/skills/example-skill/SKILL.md", p));
    });

    await t.step("repo release without a bump after a change fails or bumps, per --no-bump", () => {
      t.write("recipes/e2e/example/skills/example-skill/SKILL.tpl.md", `${t.read("recipes/e2e/example/skills/example-skill/SKILL.tpl.md", local)}\nChanged.\n`, local);
      t.sh("git add -A && git commit -qm change", { cwd: local });
      const r = t.sous(["repo", "release", "--no-bump", "--dry-run"], { cwd: local });
      assert.notEqual(r.code, 0, "an unraised change with --no-bump should be an error");
      const patch = expectExit(t.sous(["repo", "release", "--dry-run"], { cwd: local }));
      expectIncludes(patch.stderr + patch.stdout, "0.1.1", "patch bump plan");
    });

    // ---- the four test repositories ----
    for (const target of TARGETS) {
      const label = target.id;
      const name = target.url.split("/").pop();
      const recipe = `e2e${slug}${target.id.replace("-", "")}`.slice(0, 40);
      const work = path.join(t.root, `publish-${label}`);

      const skipIfNoToken = () => {
        if (target.kind === "github" && !process.env.GITHUB_TOKEN && target.private) t.skip("GITHUB_TOKEN is not set");
        if (target.kind === "gitlab" && !process.env.GITLAB_TOKEN && !process.env.E2E_GITLAB_BEARER) t.skip("GITLAB_TOKEN is not set");
      };

      await t.step(`${label}: clone, add a recipe, release and push it`, () => {
        skipIfNoToken();
        assertWritable(target.url);
        const clone = run("git", ["clone", "-q", `${target.url}.git`, work], { env: t.env });
        assert.equal(clone.code, 0, clone.stderr);
        const hasRepo = fs.existsSync(path.join(work, "sous.repo.yaml"));
        if (!hasRepo) {
          expectExit(t.sous(["repo", "init", work, "--name", name.toLowerCase(), "--namespace", "e2e", "--host", target.kind], { cwd: t.root }));
          t.sh("git add -A && git commit -qm 'Scaffold the recipe repository'", { cwd: work });
        }
        // A new recipe unique to this run, copied from the scaffold's example recipe.
        const src = path.join(work, "recipes/e2e/example");
        const dest = path.join(work, `recipes/e2e/${recipe}`);
        fs.cpSync(src, dest, { recursive: true });
        const manifest = path.join(dest, "sous.recipe.yaml");
        fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(/^name: example$/m, `name: ${recipe}`).replace(/^version: .*$/m, "version: 0.0.1"));
        const repoYaml = path.join(work, "sous.repo.yaml");
        fs.writeFileSync(repoYaml, fs.readFileSync(repoYaml, "utf8").replace(/\n?$/, `\n  - recipes/e2e/${recipe}\n`));
        t.sh(`git add -A && git commit -qm 'Add recipe e2e/${recipe}'`, { cwd: work });
        expectExit(t.sous(["repo", "release", "--yes"], { cwd: work }));
        const pushed = run("git", ["push", "origin", "HEAD:main", "--tags"], { cwd: work, env: t.env });
        assert.equal(pushed.code, 0, pushed.stderr + pushed.stdout);
      });

      await t.step(`${label}: a fresh project can repo add it, subscribe and build the recipe`, () => {
        skipIfNoToken();
        const p = t.initializedProject({ dir: `consumer-${label}` });
        const add = t.sous(["repo", "add", target.url, "--name", label, "--yes"], { cwd: p });
        assert.equal(add.code, 0, add.stderr + add.stdout);
        const sub = t.sous(["subscription", "add", `e2e/${recipe}`, "--yes"], { cwd: p });
        assert.equal(sub.code, 0, sub.stderr + sub.stdout);
        assert.ok(t.exists(".claude/skills/example-skill/SKILL.md", p), "the recipe's skill was not written");
        const json = parseJson(expectExit(t.sous(["--json", "repo", "list"], { cwd: p })).stdout);
        assert.ok(JSON.stringify(json).includes(label));
      });

      if (target.private) {
        await t.step(`${label}: repo add without a token trusts it but warns that the index cannot be read`, () => {
          const p = t.initializedProject({ dir: `anon-${label}` });
          const r = t.sous(["repo", "add", target.url, "--yes"], { cwd: p, env: { GITHUB_TOKEN: "", GITLAB_TOKEN: "", E2E_GITLAB_BEARER: "", GH_TOKEN: "", GIT_TERMINAL_PROMPT: "0", HOME: path.join(t.root, `anon-home-${label}`), SOUS_HOME: path.join(t.root, `anon-sous-home-${label}`) } });
          expectIncludes(r.stderr + r.stdout, "could not be read", "repo add output");
        });
      }
    }

    // ---- contribute and submit (public repositories only) ----
    for (const target of TARGETS.filter((x) => !x.private)) {
      const label = target.id;
      await t.step(`${label}: repo contribute --dry-run prints the steps and changes nothing`, () => {
        const p = t.initializedProject({ dir: `contrib-${label}` });
        expectExit(t.sous(["repo", "add", target.url, "--name", label, "--yes"], { cwd: p }));
        const r = t.sous(["repo", "contribute", label, "--create-branch", `e2e/${slug}-dry`, "--dry-run", "--yes"], { cwd: p });
        assert.equal(r.code, 0, r.stderr + r.stdout);
        const links = t.sous(["--json", "repo", "list"], { cwd: p });
        assert.ok(!/"linked":\s*true/.test(links.stdout), "a dry run linked the repository");
      });

      await t.step(`${label}: repo contribute, edit, repo submit opens a proposal (left open)`, () => {
        const p = path.join(t.root, `contrib-${label}`);
        const branch = `e2e/${slug}-${label}`;
        const start = t.sous(["repo", "contribute", label, "--create-branch", branch, "--yes"], { cwd: p });
        assert.equal(start.code, 0, start.stderr + start.stdout);
        const checkout = findCheckout(t, p, label);
        assertWritable(remoteOf(checkout, t));
        const note = path.join(checkout, "E2E-NOTE.md");
        fs.writeFileSync(note, `Opened by the sous end-to-end suite, run ${RUN_ID}.\n`);
        const submit = t.sous(["repo", "submit", label, "--commit", "--yes", "--title", `e2e ${RUN_ID}: harness check`, "--body", "Opened by the sous end-to-end suite. Safe to close."], { cwd: p });
        assert.equal(submit.code, 0, submit.stderr + submit.stdout);
        expectIncludes(submit.stderr + submit.stdout, target.kind === "github" ? "pull" : "merge", "submit output");
        const status = t.sous(["repo", "submit", label, "--status"], { cwd: p });
        assert.equal(status.code, 0, status.stderr + status.stdout);
      });
    }
  },
};

// Finds the working copy sous linked for a repository by asking git for checkouts under SOUS_HOME.
function findCheckout(t, project, label) {
  const json = JSON.parse(run("sous", ["--json", "repo", "list"], { cwd: project, env: t.env }).stdout || "{}");
  const text = JSON.stringify(json);
  const m = text.match(/"(?:linkedPath|linkPath|checkout|path)":"([^"]+)"/);
  if (m && fs.existsSync(path.join(m[1], ".git"))) return m[1];
  const found = run("bash", ["-lc", `find ${t.sousHome} ${project} -maxdepth 6 -name sous.repo.yaml -not -path '*/cache/*' -not -path '*/node_modules/*' | head -3`], { env: t.env }).stdout.trim().split("\n")[0];
  if (!found) throw new Error(`could not find the working copy for ${label}`);
  return path.dirname(found);
}

function remoteOf(dir, t) {
  return run("git", ["remote", "get-url", "origin"], { cwd: dir, env: t.env }).stdout.trim();
}
