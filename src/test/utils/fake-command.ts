import fs from "node:fs";
import path from "node:path";

/**
 * Fake command line tools (`gh`, `npm`, `yarn`...) for tests that boot the
 * real CLI and put a directory of fakes at the front of PATH.
 *
 * Each fake is a small CommonJS script run by this process's own Node binary,
 * reading its arguments from `process.argv.slice(2)`. Its output goes through
 * `fs.writeSync`, and its exit code through `process.exitCode`, because a fake
 * started without a shell on Windows is ended with `process.exit` as soon as
 * the script has run.
 *
 * How the script is started depends on how sous starts the tool:
 *
 * - On Linux and macOS, `<dir>/<name>` is a shell script handing its
 *   arguments to the fake, whichever way sous starts it.
 * - On Windows, a tool sous starts through the shell (the package managers) is
 *   `<dir>/<name>.cmd`, which the shell finds through PATHEXT.
 * - On Windows, a tool sous starts directly (`git`, `gh`) has to be an `.exe`,
 *   the only kind of file Windows finds on PATH without a shell. That fake is a
 *   link to the Node binary named after the tool, and a module preloaded
 *   through NODE_OPTIONS (see `fakeCommandEnv`) notices that Node is running
 *   under the tool's name and runs the fake in its place. Node reads a first
 *   argument starting with `-` as one of its own options, so such a fake
 *   cannot be handed a flag first.
 */

/** How sous starts a tool, which decides what its fake looks like on Windows. */
export type FakeCommandLaunch = "direct" | "shell";

/** The module NODE_OPTIONS preloads into every Node process on Windows. */
const PRELOAD_FILE = "fake-commands.cjs";

/**
 * The preload: when the running Node binary is one of the fakes in its own
 * directory, run that fake and exit before Node looks for a script to run.
 * Node has already resolved the first argument to an absolute path, taking it
 * for a script, so it is handed back as it was typed.
 */
const PRELOAD_SOURCE = `const path = require("node:path");
const exe = path.parse(process.execPath);
if (exe.dir.toLowerCase() === __dirname.toLowerCase()) {
  const script = path.join(__dirname, exe.name + ".fake.cjs");
  const args = process.argv.slice(1);
  if (args.length > 0 && path.dirname(args[0]) === process.cwd()) args[0] = path.basename(args[0]);
  process.argv = [process.execPath, script, ...args];
  require(script);
  process.exit();
}
`;

/**
 * Writes a fake tool into `dir`.
 *
 * writeFakeCommand(fakeBin, "gh", "direct", 'require("node:fs").writeSync(1, "ok\\n");');
 * // -> fakeBin/gh (Linux, macOS), or fakeBin/gh.exe (Windows)
 *
 * @param dir - The directory of fakes, which the test puts first on PATH.
 * @param name - The tool's name, as sous starts it.
 * @param launch - Whether sous starts the tool directly or through the shell.
 * @param source - The fake itself: a CommonJS script.
 */
export function writeFakeCommand(
  dir: string,
  name: string,
  launch: FakeCommandLaunch,
  source: string
): void {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, `${name}.fake.cjs`);
  fs.writeFileSync(script, source, "utf8");

  if (process.platform !== "win32") {
    const launcher = path.join(dir, name);
    fs.writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
      "utf8"
    );
    fs.chmodSync(launcher, 0o755);
    return;
  }

  if (launch === "shell") {
    fs.writeFileSync(
      path.join(dir, `${name}.cmd`),
      `@"${process.execPath}" "${script}" %*\r\n@exit /b %ERRORLEVEL%\r\n`,
      "utf8"
    );
    return;
  }

  const exe = path.join(dir, `${name}.exe`);
  try {
    fs.linkSync(process.execPath, exe);
  } catch {
    fs.copyFileSync(process.execPath, exe);
  }
  fs.writeFileSync(path.join(dir, PRELOAD_FILE), PRELOAD_SOURCE, "utf8");
}

/**
 * What the environment of a CLI run needs for the fakes in `dir` to work: on
 * Windows, NODE_OPTIONS preloading the module that runs a directly started
 * fake, when `dir` holds one; otherwise nothing.
 *
 * @param dir - The directory of fakes.
 */
export function fakeCommandEnv(dir: string): NodeJS.ProcessEnv {
  const file = path.join(dir, PRELOAD_FILE);
  if (process.platform !== "win32" || !fs.existsSync(file)) return {};
  // Forward slashes, so NODE_OPTIONS does not read the separators as escapes.
  const preload = file.split(path.sep).join("/");
  const existing = process.env.NODE_OPTIONS;
  const option = `--require "${preload}"`;
  return { NODE_OPTIONS: existing ? `${existing} ${option}` : option };
}
