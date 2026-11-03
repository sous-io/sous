import path from "node:path";
import { assert, expectExit, expectIncludes, parseJson, run } from "../lib/harness.mjs";

// `sous update` and `init` care about the package manager that installed sous, so each manager
// gets a project with sous installed by it.

// The newest stable version before the latest one, so `update` has somewhere to go.
let OLD_VERSION = "1.0.0";
function pickOldVersion(t) {
  const out = t.sh("npm view @sous-io/sous versions --json").stdout;
  const stable = JSON.parse(out).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  OLD_VERSION = stable[stable.length - 2] ?? stable[0];
}

let NEW = "latest";
function managers() {
  return [
    {
      id: "npm",
      setup: (t, dir) => expectExit(t.sh(`echo '{"name":"pm-npm","private":true}' > package.json && npm i --no-audit --no-fund @sous-io/sous@${NEW}`, { cwd: dir, timeout: 240_000 })),
      lockfile: "package-lock.json",
    },
    {
      id: "pnpm",
      setup: (t, dir) => expectExit(t.sh(`echo '{"name":"pm-pnpm","private":true}' > package.json && pnpm add @sous-io/sous@${NEW}`, { cwd: dir, timeout: 240_000 })),
      lockfile: "pnpm-lock.yaml",
    },
    {
      id: "yarn-pnp",
      setup: (t, dir) =>
        expectExit(
          t.sh(
            `echo '{"name":"pm-yarn","private":true}' > package.json && corepack use yarn@4 >/dev/null 2>&1; yarn config set nodeLinker pnp >/dev/null && yarn config set npmMinimalAgeGate 0 >/dev/null && touch yarn.lock && yarn add @sous-io/sous@${NEW}`,
            { cwd: dir, timeout: 300_000 },
          ),
        ),
      lockfile: "yarn.lock",
      launcher: ["yarn", "sous"],
    },
  ];
}

export default {
  name: "update",
  title: "Update: sous update --dry-run and init through npm, pnpm and Yarn Plug'n'Play",
  async run(t) {
    pickOldVersion(t);
    NEW = t.requestedVersion;
    for (const pm of managers()) {
      const dir = t.project({ dir: `pm-${pm.id}`, git: true });
      let sous;
      let ready = false;
      let initOk = false;
      await t.step(`${pm.id}: install @sous-io/sous@${NEW} into a fresh project`, () => {
        pm.setup(t, dir);
        assert.ok(t.exists(pm.lockfile, dir), `${pm.lockfile} was not written`);
        sous = (args, opts = {}) => {
          if (pm.launcher) return run(pm.launcher[0], [...pm.launcher.slice(1), ...args], { cwd: dir, env: { ...t.env, ...(opts.env ?? {}) } });
          return run(path.join(dir, "node_modules/.bin/sous"), args, { cwd: dir, env: { ...t.env, ...(opts.env ?? {}) } });
        };
        ready = true;
      });

      await t.step(`${pm.id}: the project's own install reports the version under test`, () => {
        if (!ready) t.skip("install failed");
        expectIncludes(expectExit(sous(["--version"])).stdout, t.sousVersion.replace(/^v/, ""), "version");
      });

      await t.step(`${pm.id}: init works with this package manager`, () => {
        if (!ready) t.skip("install failed");
        const r = sous(["init", "--yes"]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        assert.ok(t.exists(".sous/sous.config.js", dir));
        initOk = true;
      });

      await t.step(`${pm.id}: update --project --dry-run names ${pm.id} and installs nothing`, () => {
        if (!ready) t.skip("install failed");
        if (!initOk) t.skip("init did not produce a loadable config, see the init step");
        const before = t.read(pm.lockfile, dir);
        const r = sous(["update", "--project", "--dry-run"]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        const text = r.stderr + r.stdout;
        expectIncludes(text.toLowerCase(), pm.id.split("-")[0], "update plan");
        assert.equal(t.read(pm.lockfile, dir), before, "dry run changed the lockfile");
        expectIncludes(expectExit(sous(["--version"])).stdout, t.sousVersion.replace(/^v/, ""), "version after dry run");
      });

      await t.step(`${pm.id}: update --dry-run --json is one object`, () => {
        if (!ready) t.skip("install failed");
        if (!initOk) t.skip("init did not produce a loadable config, see the init step");
        const r = sous(["--json", "update", "--project", "--dry-run"]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        parseJson(r.stdout);
      });

      await t.step(`${pm.id}: update --project --version <older> --yes changes the installed version`, () => {
        if (!ready) t.skip("install failed");
        if (!initOk) t.skip("init did not produce a loadable config, see the init step");
        const r = sous(["update", "--project", "--yes", "--no-build", "--version", OLD_VERSION]);
        assert.equal(r.code, 0, r.stderr + r.stdout);
        // Check what the package manager installed, not by running the older sous: an older release
        // need not load this project (Yarn Plug'n'Play loads only from 1.0.8 on).
        expectIncludes(t.read(pm.lockfile, dir), OLD_VERSION, "lockfile after update");
      });
    }

    await t.step("update --version with an unknown version fails naming it", () => {
      const dir = path.join(t.root, "pm-npm");
      const r = run(path.join(dir, "node_modules/.bin/sous"), ["update", "--project", "--dry-run", "--version", "99.99.99"], { cwd: dir, env: t.env });
      assert.notEqual(r.code, 0);
      expectIncludes(r.stderr, "99.99.99", "stderr");
    });
  },
};
