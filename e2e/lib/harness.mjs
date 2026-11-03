// The small test kit every scenario uses. A scenario is `export default { name, run(t) }`;
// `t.step(name, fn)` records one assertion group, and a failing step does not stop the
// scenario, so one run shows every problem.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWritable } from "./allowlist.mjs";

export { assert };

const SECRETS = () =>
  [process.env.GITHUB_TOKEN, process.env.GITLAB_TOKEN, process.env.GH_TOKEN, process.env.E2E_GITLAB_BEARER].filter(
    (v) => v && v.length > 6,
  );

// Removes every token from text before it is stored, printed or put in an error message.
export function scrub(text) {
  let out = String(text ?? "");
  for (const secret of SECRETS()) out = out.split(secret).join("***");
  return out;
}

// Messages sous prints on every run in a fresh container because the first pass is slow.
const TIMING_NOISE = /^Warning: config pass .* took .*\n(?:  .*\n)*?  See every timing with --timings\.\n/gm;
export function withoutTimingNoise(text) {
  return String(text).replace(TIMING_NOISE, "");
}

export const RUN_ID = process.env.E2E_RUN_ID || `${Date.now().toString(36)}`;

export class SkipError extends Error {}

// Runs a program and returns { code, stdout, stderr }. Never throws on a non-zero exit.
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input ?? "",
    encoding: "utf8",
    timeout: options.timeout ?? 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    code: result.status ?? (result.signal ? 128 : 1),
    stdout: scrub(result.stdout),
    stderr: scrub(result.stderr),
    command: [command, ...args].join(" "),
  };
}

export function describeRun(r) {
  const cut = (s) => (s.length > 1500 ? `${s.slice(0, 1500)}\n...(cut)` : s);
  return `$ ${r.command}\nexit ${r.code}\n--- stdout\n${cut(r.stdout)}\n--- stderr\n${cut(r.stderr)}`;
}

export function expectExit(r, code = 0) {
  if (r.code !== code) throw new Error(`expected exit ${code}\n${describeRun(r)}`);
  return r;
}

export function expectIncludes(text, needle, label = "text") {
  if (!String(text).includes(needle)) {
    throw new Error(`${label} should include ${JSON.stringify(needle)}, got:\n${String(text).slice(0, 1500)}`);
  }
}

export function expectNotIncludes(text, needle, label = "text") {
  if (String(text).includes(needle)) {
    throw new Error(`${label} should not include ${JSON.stringify(needle)}, got:\n${String(text).slice(0, 1500)}`);
  }
}

export function parseJson(text, label = "stdout") {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not one JSON object (${error.message}):\n${String(text).slice(0, 800)}`);
  }
}

// A throwaway machine for one scenario: its own HOME, SOUS_HOME and working directory.
export function createScenarioContext(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `e2e-${name}-`));
  const home = path.join(root, "home");
  const sousHome = path.join(root, "sous-home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(sousHome, { recursive: true });
  const baseEnv = { HOME: home, SOUS_HOME: sousHome, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" };
  // A GitLab OAuth token only works as a Bearer token, and glab knows that from its config file
  // (mode 600, inside this throwaway HOME, which disappears with the container).
  if (process.env.E2E_GITLAB_BEARER) {
    const dir = path.join(home, ".config", "glab-cli");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      `hosts:\n    gitlab.com:\n        token: ${process.env.E2E_GITLAB_BEARER}\n        is_oauth2: "true"\n        api_protocol: https\n        git_protocol: https\n        api_host: gitlab.com\n`,
      { mode: 0o600 },
    );
  }
  const results = [];
  let projectCount = 0;

  const t = {
    name,
    root,
    home,
    sousHome,
    env: baseEnv,
    results,

    async step(stepName, fn) {
      const started = Date.now();
      try {
        await fn();
        results.push({ step: stepName, status: "pass", ms: Date.now() - started });
      } catch (error) {
        if (error instanceof SkipError) {
          results.push({ step: stepName, status: "skip", reason: error.message, ms: 0 });
        } else {
          results.push({
            step: stepName,
            status: "fail",
            error: scrub(error?.message ?? error),
            ms: Date.now() - started,
          });
        }
      }
    },

    skip(reason) {
      throw new SkipError(reason);
    },

    // Runs `sous` with the scenario's environment. `args` is an array.
    sous(args, options = {}) {
      return run("sous", args, {
        cwd: options.cwd ?? t.cwd ?? root,
        env: { ...baseEnv, ...(options.env ?? {}) },
        input: options.input,
        timeout: options.timeout,
      });
    },

    sh(command, options = {}) {
      return run("bash", ["-lc", command], {
        cwd: options.cwd ?? t.cwd ?? root,
        env: { ...baseEnv, ...(options.env ?? {}) },
        input: options.input,
        timeout: options.timeout,
      });
    },

    // Creates a project directory with a package.json that has no "type" field (what most
    // projects have) and a git repository, and makes it the default working directory.
    project(options = {}) {
      projectCount += 1;
      const dir = path.join(root, options.dir ?? `project-${projectCount}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "package.json"),
        `${JSON.stringify({ name: options.name ?? `proj${projectCount}`, private: true, ...(options.packageJson ?? {}) }, null, 2)}\n`,
      );
      if (options.git !== false) {
        run("git", ["init", "-q"], { cwd: dir, env: baseEnv });
      }
      t.cwd = dir;
      return dir;
    },

    // A project that has been through `sous init --no-build`.
    initializedProject(options = {}) {
      const dir = t.project(options);
      expectExit(t.sous(["init", "--no-build"], { cwd: dir }));
      return dir;
    },

    write(file, content, cwd = t.cwd) {
      const full = path.resolve(cwd, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
      return full;
    },
    read(file, cwd = t.cwd) {
      return fs.readFileSync(path.resolve(cwd, file), "utf8");
    },
    exists(file, cwd = t.cwd) {
      return fs.existsSync(path.resolve(cwd, file));
    },

    // Remote-writing helpers. Every one checks the allowlist first.
    assertWritable,
    gitPush(cwd, remoteUrl, args = []) {
      assertWritable(remoteUrl);
      return run("git", ["push", remoteUrl, ...args], { cwd, env: baseEnv });
    },
    requireToken(kind) {
      const name = kind === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
      if (!process.env[name]) t.skip(`${name} is not set, so this step cannot reach the private test repository`);
    },
  };
  return t;
}
