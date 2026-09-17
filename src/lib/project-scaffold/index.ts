/**
 * Scaffolding a project's `.sous/` directory, which is what `sous init` does.
 *
 * The scaffold is planned in memory first, checked against what is already on
 * disk, and only then written. Once written, the config is read back through
 * the very loader every command uses, so a scaffold sous itself cannot load is
 * never reported as a success.
 *
 * It refuses to touch a project that is already set up: a `.sous/` directory
 * holding a primary config is left exactly as it is, and so is any file the
 * scaffold would otherwise write. Two files are merged rather than replaced:
 * `.sous/.gitignore`, whose sous-managed block is applied by the same writer
 * `sous repo link` uses, so running the scaffold over an existing ignore file
 * never duplicates an entry; and the project's `package.json`, when there is
 * one, which gains `@sous-io/sous` as a devDependency at the running version
 * unless it already depends on it. A project that installs sous pins the
 * version its templates were written against, and a global sous hands off to
 * that copy, so the dependency is what makes every build of the project use
 * one version. Nothing is installed: the project's own package manager does
 * that, and sous does not guess which one it is.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../errors.js";
import {
  CONFIG_FILE_NAMES,
  ENV_DEFAULTS_NAME,
  ENV_LOCAL_NAME,
  SOUS_DIR_NAME,
  findConfigInSousDir,
  resolveConfigFlag,
} from "../config-discovery.js";
import { applyManagedIgnoreBlock } from "../repos/links.js";
import { loadSettings } from "../settings.js";
import {
  PROJECT_CONFIG_FORMATS,
  STARTER_PROMPT_RELATIVE_PATH,
  buildConfigJs,
  buildConfigJson,
  buildEnvDefaults,
  buildEnvLocalExample,
  buildStarterPrompt,
  type ProjectConfigFormat,
  type ProjectScaffoldContext,
} from "./templates.js";

export * from "./templates.js";

/** The npm package a scaffolded project is made to depend on. */
export const SOUS_PACKAGE_NAME = "@sous-io/sous";

/** What the scaffold did about the project's package.json. */
export type PackageJsonOutcome =
  | { kind: "absent" }
  | { kind: "present"; path: string; range: string; section: "dependencies" | "devDependencies" }
  | { kind: "added"; path: string; range: string };

/** What to scaffold, and where. */
export type ProjectScaffoldOptions = {
  /**
   * Absolute path to the `.sous/` directory to create. Its parent is the
   * project root, which is where the starter prompt compiles to.
   */
  sousDir: string;
  /** Which config format to write. Defaults to the first of `PROJECT_CONFIG_FORMATS`. */
  format?: ProjectConfigFormat;
  /** The project's display name. Defaults to the project root's own directory name. */
  name?: string;
  /** Work out every file, check the target, but write nothing. */
  dryRun?: boolean;
  /** The version of sous doing the scaffolding, named in the generated files. */
  sousVersion: string;
};

/** What a scaffold produced. */
export type ProjectScaffoldResult = {
  /** The `.sous/` directory the scaffold was written into. */
  sousDir: string;
  /** The project root: the parent of `sousDir`. */
  projectRoot: string;
  /** Absolute path of the primary config that was written. */
  configPath: string;
  /** The format the config was written in. */
  format: ProjectConfigFormat;
  /** The display name written into the config. */
  name: string;
  /** Paths of every file written, relative to the project root, in the order written. */
  files: string[];
  /** Whether `@sous-io/sous` was added to the project's package.json, was already there, or there is no package.json. */
  packageJson: PackageJsonOutcome;
  /** True when nothing was actually written. */
  dryRun: boolean;
};

/** One planned file: where it goes, and what goes in it. */
type PlannedFile = {
  /** Path relative to the project root. */
  relativePath: string;
  /** The complete file contents. */
  contents: string;
  /**
   * True for a file whose existing contents were merged into `contents`
   * rather than a file the scaffold refuses to write over.
   */
  merged?: boolean;
};

/** The file name a config of the given format is written under. */
export function configFileNameFor(format: ProjectConfigFormat): string {
  const name = `sous.config.${format}`;
  /* c8 ignore next 5 */
  if (!(CONFIG_FILE_NAMES as readonly string[]).includes(name)) {
    throw new ConfigError(
      `sous cannot write a '${format}' config: discovery does not recognize ${name}.`
    );
  }
  return name;
}

/**
 * Creates a project's `.sous/` directory: a primary config, the starter prompt
 * it compiles, the two answers files, and the sous-managed block in
 * `.sous/.gitignore`.
 *
 * @param options - What to scaffold, and where.
 * @throws ConfigError when the target already holds a primary config, or any
 *   other file the scaffold would write, or when the written config does not
 *   load.
 */
export async function scaffoldProject(
  options: ProjectScaffoldOptions
): Promise<ProjectScaffoldResult> {
  const sousDir = path.resolve(options.sousDir);
  const projectRoot = path.dirname(sousDir);
  const format = options.format ?? PROJECT_CONFIG_FORMATS[0];
  const name = (options.name ?? path.basename(projectRoot)).trim() || path.basename(projectRoot);
  const dryRun = options.dryRun === true;

  assertNoExistingConfig(sousDir);

  const context: ProjectScaffoldContext = { name, sousVersion: options.sousVersion };
  const files = planFiles(sousDir, projectRoot, format, context);
  const dependency = planPackageJson(projectRoot, options.sousVersion);
  if (dependency.file !== undefined) files.push(dependency.file);

  assertNothingWouldBeOverwritten(projectRoot, files);

  const configPath = path.join(sousDir, configFileNameFor(format));

  if (!dryRun) {
    for (const file of files) {
      const target = path.join(projectRoot, file.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.contents, "utf8");
    }
    await verifyScaffold(configPath, projectRoot);
  }

  return {
    sousDir,
    projectRoot,
    configPath,
    format,
    name,
    files: files.map((file) => file.relativePath),
    packageJson: dependency.outcome,
    dryRun,
  };
}

/**
 * Works out the package.json edit: nothing when the project has no
 * package.json or already depends on sous, otherwise the file rewritten with
 * `@sous-io/sous` in `devDependencies` at exactly the running version. The
 * file's own indentation and trailing newline are kept, and `devDependencies`
 * stays sorted the way npm keeps it. A package.json that is not JSON is
 * refused by name, before anything is written.
 */
function planPackageJson(
  projectRoot: string,
  sousVersion: string
): { file?: PlannedFile; outcome: PackageJsonOutcome } {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) return { outcome: { kind: "absent" } };

  const raw = fs.readFileSync(packageJsonPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `'sous init' would add ${SOUS_PACKAGE_NAME} to ${packageJsonPath}, but could not read it as JSON.\n` +
        `  ${(error as Error).message}\n` +
        `  Fix the file, or run 'sous init' in a directory without a package.json.`
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      `'sous init' would add ${SOUS_PACKAGE_NAME} to ${packageJsonPath}, but it does not hold a JSON object.`
    );
  }
  const pkg = parsed as Record<string, unknown>;

  for (const section of ["dependencies", "devDependencies"] as const) {
    const deps = pkg[section];
    if (typeof deps === "object" && deps !== null && SOUS_PACKAGE_NAME in deps) {
      const range = String((deps as Record<string, unknown>)[SOUS_PACKAGE_NAME]);
      return { outcome: { kind: "present", path: packageJsonPath, range, section } };
    }
  }

  const existing =
    typeof pkg.devDependencies === "object" && pkg.devDependencies !== null
      ? (pkg.devDependencies as Record<string, unknown>)
      : {};
  const devDependencies = Object.fromEntries(
    Object.entries({ ...existing, [SOUS_PACKAGE_NAME]: sousVersion }).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  );

  const indent = raw.match(/^(\s+)"/m)?.[1] ?? "  ";
  const newline = raw.endsWith("\n") ? "\n" : "";
  const contents = JSON.stringify({ ...pkg, devDependencies }, null, indent) + newline;

  return {
    file: { relativePath: "package.json", contents, merged: true },
    outcome: { kind: "added", path: packageJsonPath, range: sousVersion },
  };
}

/** Builds every file the scaffold writes, in the order they are written. */
function planFiles(
  sousDir: string,
  projectRoot: string,
  format: ProjectConfigFormat,
  context: ProjectScaffoldContext
): PlannedFile[] {
  const inSousDir = (name: string): string =>
    path.relative(projectRoot, path.join(sousDir, name));

  const gitignorePath = path.join(sousDir, ".gitignore");
  const existingIgnore = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf8")
    : undefined;

  return [
    {
      relativePath: inSousDir(configFileNameFor(format)),
      contents: format === "json" ? buildConfigJson(context) : buildConfigJs(context),
    },
    {
      relativePath: inSousDir(STARTER_PROMPT_RELATIVE_PATH),
      contents: buildStarterPrompt(context),
    },
    { relativePath: inSousDir(ENV_DEFAULTS_NAME), contents: buildEnvDefaults(context) },
    {
      relativePath: inSousDir(`${ENV_LOCAL_NAME}.example`),
      contents: buildEnvLocalExample(context),
    },
    {
      relativePath: inSousDir(".gitignore"),
      contents: applyManagedIgnoreBlock(existingIgnore, gitignorePath),
      merged: true,
    },
  ];
}

/**
 * Refuses to scaffold a `.sous/` directory that already holds a primary
 * config. The config is what makes a directory a sous project, so that is what
 * is checked; a `.sous/` holding only, say, task files is a fine place to set
 * one up.
 */
function assertNoExistingConfig(sousDir: string): void {
  const existing = findConfigInSousDir(sousDir);
  if (existing !== null) {
    throw new ConfigError(
      `${path.dirname(sousDir)} is already set up for sous.\n` +
        `  ${existing} exists, and sous will not overwrite it.\n` +
        `  Edit that config instead, or run 'sous init' in another directory.`
    );
  }
}

/**
 * Refuses to write over any file the scaffold produces, so a run that fails
 * here has changed nothing. The merged ignore file is exempt: its existing
 * lines are carried into what is written.
 */
function assertNothingWouldBeOverwritten(projectRoot: string, files: PlannedFile[]): void {
  const clashes = files
    .filter((file) => file.merged !== true)
    .map((file) => path.join(projectRoot, file.relativePath))
    .filter((target) => fs.existsSync(target));

  if (clashes.length === 0) return;

  throw new ConfigError(
    `${projectRoot} already holds ${clashes.length === 1 ? "a file" : "files"} that ` +
      `'sous init' would write, and sous will not overwrite ${clashes.length === 1 ? "it" : "them"}:\n` +
      clashes.map((target) => `    ${target}`).join("\n") +
      `\n  Move ${clashes.length === 1 ? "it" : "them"} aside, or run 'sous init' in another directory.`
  );
}

/**
 * Loads the written config through the same loader every command uses, so
 * the scaffold is never reported as a success unless sous can actually read
 * it. A failure here is a bug in the scaffold, and is reported as one.
 */
async function verifyScaffold(configPath: string, projectRoot: string): Promise<void> {
  try {
    await loadSettings(resolveConfigFlag(configPath, projectRoot));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      `The config 'sous init' wrote at ${configPath} does not load.\n` +
        `  This is a bug in sous; please report it. The loader said:\n` +
        `${reason
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n")}`
    );
  }
}

/** The `.sous/` directory a project root would hold. */
export function sousDirFor(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), SOUS_DIR_NAME);
}
