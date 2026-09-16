/**
 * The hand-off from the sous that was invoked to the sous a project installs.
 *
 * A global install is a convenience launcher; a project's own `@sous-io/sous`
 * dependency is the version its templates and its lockfile were written
 * against, and it is the one that has to do the work (the implicit `core`
 * subscription asks for exactly the running version, so two versions taking
 * turns in one project rewrite the committed lockfile back and forth). The
 * published bin (bin/run.js) calls `handOffToProjectInstall` before it loads
 * anything else, and when a project copy is found, imports that copy's own bin
 * in this same process and lets it run the command.
 *
 * Plain JavaScript ESM, no TypeScript syntax: this runs BEFORE tsx is
 * registered, under bare Node, because the whole point is to load none of the
 * invoked install's code when another copy should run. It ships to npm via the
 * package.json "files": "src" allowlist, like the config kernel next to it.
 *
 * The rules, all of them here and nowhere else:
 *   - The lookup walks up from the working directory looking for
 *     `node_modules/@sous-io/sous`, the way Node resolves a package, so a copy
 *     hoisted to a monorepo root is found from any package inside it.
 *   - A copy whose real path is the invoked install's own root is "self", and
 *     self never hands off; that is what stops the project's copy from
 *     handing off to itself after the global copy handed off to it.
 *   - The copy's bin is read from its package.json `bin` field, never assumed,
 *     so an older layout (the bin was once called `xcv`) still works.
 *   - Anything unreadable or ambiguous means "run the copy that was invoked".
 *     A hand-off is a convenience; a refusal to run is not.
 *   - `SOUS_NO_DELEGATE` (anything but 0/false/no/off) runs the invoked copy.
 *   - The notice goes to stderr, so piped stdout stays clean, and only when
 *     the two versions differ; `SOUS_DEBUG` prints it on every hand-off. It is
 *     one line naming the version handed off to; `--verbose` anywhere on the
 *     command line (or `SOUS_DEBUG`) adds where both installs are and how to
 *     keep the invoked one running.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** The npm package name a project copy is looked up under. */
export const PACKAGE_NAME = "@sous-io/sous";

/** The environment variable that keeps the invoked copy running. */
export const NO_DELEGATE_ENV = "SOUS_NO_DELEGATE";

/** The environment variable that makes every hand-off announce itself. */
export const DEBUG_ENV = "SOUS_DEBUG";

/** The flag that makes the notice say where both installs are. */
export const VERBOSE_FLAG = "--verbose";

/**
 * Whether an on/off environment variable is on: set to anything but an empty
 * string, `0`, `false`, `no` or `off` (case-insensitive, whitespace trimmed).
 * The same reading `SOUS_DEBUG` has always had.
 */
export function isEnvFlagOn(value) {
  return !["", "0", "false", "no", "off"].includes((value ?? "").trim().toLowerCase());
}

/**
 * Reads a package.json, returning the parsed object or undefined for a file
 * that is missing, unreadable or not JSON.
 */
function readPackageJson(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Works out which file a package's `bin` field names for the `sous` command,
 * relative to the package root, or undefined when it cannot be told: no field,
 * an object naming neither `sous` nor `xcv` with more than one entry, or a
 * value that is not a string.
 */
export function binEntryOf(pkg) {
  const bin = pkg?.bin;
  if (typeof bin === "string") return bin;
  if (!bin || typeof bin !== "object") return undefined;
  const named = bin.sous ?? bin.xcv;
  if (typeof named === "string") return named;
  const entries = Object.values(bin);
  if (entries.length === 1 && typeof entries[0] === "string") return entries[0];
  return undefined;
}

/**
 * Looks up from `startDir` for a project install of the package.
 *
 * Returns undefined when no ancestor holds `node_modules/@sous-io/sous`, or
 * when the first one found is not usable (its package.json does not name the
 * package, or its bin cannot be determined or does not exist). Returns
 * `{ same: true, root }` when the first copy found IS the invoked install
 * (`ownRoot`), compared by real path, and otherwise `{ same: false, root,
 * version, bin }` with `bin` as an absolute path.
 *
 * The walk stops at the first copy, usable or not: a broken copy nearer the
 * working directory is what `npx` would run too, and skipping past it to an
 * older one further up would be a guess.
 */
export function findProjectInstall(startDir, ownRoot) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...PACKAGE_NAME.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return describeInstall(candidate, ownRoot);
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function describeInstall(candidate, ownRoot) {
  const root = realpathOr(candidate);
  if (root === realpathOr(ownRoot)) return { same: true, root };
  const pkg = readPackageJson(root);
  if (!pkg || pkg.name !== PACKAGE_NAME) return undefined;
  const entry = binEntryOf(pkg);
  if (!entry) return undefined;
  const bin = path.resolve(root, entry);
  if (!fs.existsSync(bin)) return undefined;
  return { same: false, root, version: typeof pkg.version === "string" ? pkg.version : "unknown", bin };
}

/**
 * The lines the notice is made of: one line naming the version handed off to,
 * and, when verbose, where both installs are and how to keep the invoked one
 * running. Plain text, because this prints before tsx exists; the block
 * mirrors the shape `showVariables` gives a key and value list.
 */
export function formatHandoffNotice({ install, ownVersion, ownRoot, verbose }) {
  const lines = [`Handing off to the project-level Sous install: v${install.version}`];
  if (verbose) {
    lines.push(
      `    Project install: ${install.root}`,
      `    Invoked install: v${ownVersion} at ${ownRoot}`,
      `Set ${NO_DELEGATE_ENV}=1 to run the invoked install instead.`
    );
  }
  return lines;
}

/**
 * Decides what the invoked install should do, without doing it.
 *
 * Returns `{ kind: "run-self" }` when the invoked copy runs the command, or
 * `{ kind: "hand-off", install, notice }` naming the project copy to import
 * and the lines to print on stderr first (an empty list when nothing is said).
 */
export function planHandoff({ cwd, ownRoot, env, argv = [] }) {
  if (isEnvFlagOn(env[NO_DELEGATE_ENV])) return { kind: "run-self" };
  const install = findProjectInstall(cwd, ownRoot);
  if (!install || install.same) return { kind: "run-self" };

  const ownPkg = readPackageJson(ownRoot);
  const ownVersion = typeof ownPkg?.version === "string" ? ownPkg.version : "unknown";
  const debug = isEnvFlagOn(env[DEBUG_ENV]);
  const announce = ownVersion !== install.version || debug;
  const notice = announce
    ? formatHandoffNotice({
        install,
        ownVersion,
        ownRoot: realpathOr(ownRoot),
        verbose: debug || argv.includes(VERBOSE_FLAG),
      })
    : [];
  return { kind: "hand-off", install, notice };
}

/**
 * Hands the current invocation to the project's copy when there is one to hand
 * it to. Resolves true after that copy's bin has run (it reads the same
 * process.argv and sets the same exit code), and false, having loaded nothing,
 * when the invoked copy should run the command itself.
 */
export async function handOffToProjectInstall({
  ownRoot,
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv.slice(2),
  stderr = process.stderr,
}) {
  const plan = planHandoff({ cwd, ownRoot, env, argv });
  if (plan.kind !== "hand-off") return false;
  for (const line of plan.notice) stderr.write(`${line}\n`);
  await import(pathToFileURL(plan.install.bin).href);
  return true;
}
