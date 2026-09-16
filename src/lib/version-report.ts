/**
 * What `sous --version` prints.
 *
 * oclif answers `--version` with its user agent string (package, version,
 * platform and Node build on one line). Sous answers it itself, in bin/run.js,
 * before oclif is loaded: the version alone, or with `--verbose` the same facts
 * as a key and value list, so a person asking "which sous is this?" gets one
 * short line and a person asking "where is it?" gets the rest.
 */

import fs from "node:fs";
import os from "node:os";
import { log, showVariables } from "../utils/formatting.js";

/** The one flag oclif treats as a version request, and so does sous. */
export const VERSION_FLAG = "--version";

/** The flag that adds where the install is, the platform and the Node build. */
export const VERBOSE_FLAG = "--verbose";

/** The facts a version report is made of. */
export type VersionFacts = {
  /** The npm package name. */
  name: string;
  /** The package version. */
  version: string;
  /** The absolute path of the install answering. */
  root: string;
  /** The platform and architecture, the way oclif spells them. */
  platform: string;
  /** The Node build, with its leading `v`. */
  node: string;
};

/** Whether the command line is a version request: `--version` as its first word. */
export function isVersionRequest(argv: readonly string[]): boolean {
  return argv[0] === VERSION_FLAG;
}

/** Reads the facts about the install rooted at `packageRoot`. */
export function readVersionFacts(packageRoot: string): VersionFacts {
  const pkg = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  return {
    name: typeof pkg.name === "string" ? pkg.name : "unknown",
    version: typeof pkg.version === "string" ? pkg.version : "unknown",
    root: packageRoot,
    platform: `${os.platform()}-${os.arch()}`,
    node: process.version,
  };
}

/**
 * Prints the report: the version on its own line, and with `verbose` the
 * facts under it as a key and value list.
 *
 * @param facts - What to report.
 * @param verbose - Whether to print the facts under the version.
 * @param write - Where each line goes; standard output by default.
 */
export function printVersionReport(
  facts: VersionFacts,
  verbose: boolean,
  write: (line: string) => void = log
): void {
  write(`v${facts.version}`);
  if (!verbose) return;
  showVariables(
    {
      Package: facts.name,
      Install: facts.root,
      Platform: facts.platform,
      Node: facts.node,
    },
    { write }
  );
}

/**
 * Answers a version request from the command line: `sous --version`, or
 * `sous --version --verbose`.
 *
 * @param argv - The command line after the program name.
 * @param packageRoot - The root of the install answering.
 */
export function printVersion(argv: readonly string[], packageRoot: string): void {
  printVersionReport(readVersionFacts(packageRoot), argv.includes(VERBOSE_FLAG));
}
