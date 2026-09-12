/**
 * `sous recipe show <ref>`.
 *
 * Shows one recipe in full: where it is published, every version it publishes,
 * what the version this project would use depends on, the questions it asks,
 * and where its files land in this project. It reads only what sous already has
 * on disk: the repository's cached index, the project's lockfile, and the
 * recipe's own files when they are in the store or a linked working copy.
 */

import { Args } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { resolveRootScope } from "../../lib/settings.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { catalogContextFor } from "../../lib/repos/catalog-inputs.js";
import {
  describeRecipe,
  type RecipeContentListing,
  type RecipeDependencyListing,
  type RecipeVariableListing,
  type RecipeVersionListing,
} from "../../lib/repos/catalog.js";
import {
  INDENT,
  describeVersionStatus,
  factIf,
  printFacts,
} from "../../lib/repos/catalog-display.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  paragraph,
  showCommandVars,
  subheading,
} from "../../utils/formatting.js";

/** The columns the version history shows. */
const VERSION_COLUMNS: TableColumn[] = [
  { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
  { key: "status", header: "What it is", overflow: "wrap", flex: 1, minWidth: 16 },
  { key: "prerelease", header: "Prerelease", priority: "medium" },
  { key: "released", header: "Released", overflow: "truncate", priority: "low" },
];

/** The columns the dependency listing shows. */
const DEPENDENCY_COLUMNS: TableColumn[] = [
  { key: "key", header: "Dependency", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "declared", header: "Declared as", overflow: "wrap", flex: 1, minWidth: 12 },
  { key: "resolved", header: "Resolved to", overflow: "truncate", minWidth: 11 },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "low", minWidth: 12 },
  { key: "kind", header: "Kind", overflow: "wrap", priority: "medium", minWidth: 16 },
];

/** The columns the variable listing shows. */
const VARIABLE_COLUMNS: TableColumn[] = [
  { key: "name", header: "Variable", overflow: "truncate", minWidth: 10 },
  { key: "type", header: "Type", priority: "medium" },
  { key: "env", header: "Environment variable", overflow: "truncate", minWidth: 12 },
  { key: "required", header: "Required", priority: "medium" },
  { key: "secret", header: "Secret", priority: "low" },
  { key: "prompt", header: "What it asks", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

/** The columns the content listing shows. */
const CONTENT_COLUMNS: TableColumn[] = [
  { key: "kind", header: "Content", minWidth: 7 },
  { key: "include", header: "Files", overflow: "wrap", flex: 1, minWidth: 14 },
  {
    key: "destination",
    header: "Where they land",
    kind: "path",
    overflow: "wrap",
    flex: 2,
    minWidth: 16,
  },
];

export default class RecipeShow extends BaseCommand {
  static description = "Show one recipe: its versions, dependencies, variables and files";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["recipes:show"];

  static examples = [
    "<%= config.bin %> recipe show workflow/task-files",
    "<%= config.bin %> recipe show task-files",
    "<%= config.bin %> recipe show sous-recipes:core/about-sous",
  ];

  static args = {
    ref: Args.string({
      description:
        "A recipe, written as 'namespace/recipe', a recipe name on its own, or either with a 'repository:' qualifier",
      required: true,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args } = await this.parse(RecipeShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Recipe: args.ref,
    });

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs } = catalogContextFor({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      scope: resolveRootScope(this.settings, this.configContext),
    });

    const detail = describeRecipe(inputs, args.ref);

    heading(detail.key);
    blankLine();

    printFacts([
      { label: "Repository", lines: [detail.repo] },
      ...factIf("Location", detail.repoUrl),
      ...factIf("About", detail.description),
      { label: "Folder", lines: [detail.path] },
      { label: "Latest version", lines: [detail.latest ?? "none published"] },
      { label: "Pinned version", lines: [detail.pinned ?? "this project pins none"] },
      { label: "Subscribed", lines: [detail.subscribed ? "yes" : "no"] },
      ...factIf("Described below", detail.describing),
    ]);

    this.printVersions(detail.versions);
    this.printDependencies(detail.dependencies, detail.manifestRead);

    if (!detail.manifestRead) {
      blankLine();
      paragraph(
        "The recipe's own files are not on this machine, so the questions it asks and " +
          "the files it publishes are not known here. Subscribing to it fetches them."
      );
      footer();
      return;
    }

    this.printVariables(detail.variables);
    this.printContents(detail.contents);

    footer();
  }

  /**
   * Every published version, newest first, with what each one is to this
   * project.
   *
   * @param versions - The versions the catalog listed.
   */
  private printVersions(versions: RecipeVersionListing[]): void {
    blankLine();
    subheading("Published versions");
    blankLine();

    const rows = versions.map((entry) => ({
      version: entry.version,
      status: describeVersionStatus(entry.status),
      prerelease: entry.prerelease ? "yes" : "no",
      released: entry.releasedAt ?? "not recorded",
    }));

    for (const line of renderTable(VERSION_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }
  }

  /**
   * What the described version depends on, from both sides: what the recipe's
   * manifest declares, and what its repository's index resolved that to when it
   * was released.
   *
   * @param dependencies - The dependencies the catalog listed.
   * @param manifestRead - Whether the recipe's own manifest could be read.
   */
  private printDependencies(
    dependencies: RecipeDependencyListing[],
    manifestRead: boolean
  ): void {
    blankLine();
    subheading("What it depends on");
    blankLine();

    if (dependencies.length === 0) {
      paragraph(
        manifestRead
          ? "This recipe depends on nothing else."
          : "The repository's index records no dependencies for this version."
      );
      return;
    }

    const rows = dependencies.map((entry) => ({
      key: entry.key,
      declared: entry.declared ?? "not declared in the manifest",
      resolved:
        entry.resolvedVersion ??
        (entry.resolvedRange === undefined
          ? "not recorded in the index"
          : `the range ${entry.resolvedRange}`),
      repo: entry.repo ?? "this repository",
      kind: describeDependencyKind(entry.kind),
    }));

    for (const line of renderTable(DEPENDENCY_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }
  }

  /**
   * The questions the recipe asks, and the environment variable each answer is
   * stored under.
   *
   * @param variables - The variables the catalog listed.
   */
  private printVariables(variables: RecipeVariableListing[]): void {
    blankLine();
    subheading("What it asks you");
    blankLine();

    if (variables.length === 0) {
      paragraph("This recipe asks no questions.");
      return;
    }

    const rows = variables.map((entry) => ({
      name: entry.name,
      type: entry.type,
      env: entry.env,
      required: entry.required ? "yes" : "no",
      secret: entry.secret ? "yes" : "no",
      prompt: entry.prompt,
    }));

    for (const line of renderTable(VARIABLE_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }
  }

  /**
   * What the recipe contributes, and where each kind's files are written in
   * this project.
   *
   * @param contents - The content kinds the catalog listed.
   */
  private printContents(contents: RecipeContentListing[]): void {
    blankLine();
    subheading("Where its files land in this project");
    blankLine();

    if (contents.length === 0) {
      paragraph("This recipe publishes no files.");
      return;
    }

    const rows = contents.map((entry) => ({
      kind: entry.kind,
      include: entry.include.join(", "),
      destination:
        entry.destinations.length > 0
          ? entry.destinations.join(", ")
          : entry.kind === "config"
            ? "loaded as a config layer, so nothing is written"
            : `nowhere: this project sets no 'recipeOutputs.${entry.kind}' directory`,
    }));

    for (const line of renderTable(CONTENT_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }
  }
}

/**
 * Plain-language wording for how a dependency was declared.
 *
 * @param kind - What the manifest declared it as, when the manifest was read.
 */
function describeDependencyKind(kind: "depends" | "subscribes" | undefined): string {
  if (kind === "depends") return "build dependency";
  if (kind === "subscribes") return "co-subscription";
  return "unknown";
}
