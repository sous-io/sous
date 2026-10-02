/**
 * `sous recipe show <ref>`.
 *
 * Shows one recipe in full: where it is published, every version it publishes,
 * what the version this project would use depends on and how each dependency is
 * declared, everything subscribing to it would install, every question that
 * would ask, and where its files land in this project. It reads only what sous
 * already has on disk: the repository's cached index, the project's lockfile,
 * and the recipe's own files when they are in the store or a linked working
 * copy. The index describes each version's dependencies and questions, so a
 * recipe nothing has installed is described as fully as one in the store, its
 * files excepted. `--latest` reads the repository's index from upstream
 * instead, saving nothing, and `--installed` looks the ref up among installed
 * recipes only.
 */

import { Args } from "@oclif/core";
import semver from "semver";
import { BaseCommand } from "../../base-command.js";
import { resolveRootScope } from "../../lib/settings.js";
import {
  subscriptionServiceFor,
  type SubscriptionPreview,
  type SubscriptionService,
} from "../../lib/repos/subscription-service.js";
import { loadCatalogContext } from "../../lib/repos/catalog-inputs.js";
import {
  describeInstalled,
  describeRecipe,
  type CatalogInputs,
  type RecipeContentListing,
  type RecipeDependencyListing,
  type RecipeDetail,
  type RecipeVersionListing,
} from "../../lib/repos/catalog.js";
import { PROJECT_REQUESTER } from "../../lib/repos/resolver.js";
import { recipeRef } from "../../services/ref-resolver/index.js";
import { describeDeclaration, describeDependencyKind } from "../../lib/repos/declarations.js";
import { formatQuestionPlan } from "../../lib/vars/question-plan.js";
import { describeError } from "../../lib/repos/release/validate.js";
import {
  INDENT,
  describeIndexSource,
  describeVersionStatus,
  factIf,
  printBrowsingNotes,
  printFacts,
} from "../../lib/repos/catalog-display.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import { browsingFlags } from "../../utils/flags.js";
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

/** The columns the listing of everything a subscription installs shows. */
const INSTALLS_COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
  { key: "kind", header: "Kind", overflow: "wrap", minWidth: 16 },
  {
    key: "neededBy",
    header: "Needed by",
    overflow: "wrap",
    flex: 1,
    priority: "medium",
    minWidth: 12,
  },
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
  static description =
    "Show one recipe: its versions, dependencies, what subscribing installs and asks, and its files";

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

  static flags = { ...BaseCommand.baseFlags, ...browsingFlags() };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RecipeShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Recipe: args.ref,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs, notChecked } = await loadCatalogContext({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      scope: resolveRootScope(this.settings, this.configContext),
      latest: flags.latest,
    });

    const detail = flags.installed
      ? await describeInstalled(inputs, args.ref, describeRecipe, "recipe")
      : await describeRecipe(inputs, args.ref);

    heading(detail.key);
    blankLine();

    printFacts([
      { label: "Repository", lines: [detail.repo] },
      ...factIf("Location", detail.repoUrl),
      ...factIf("About", detail.description),
      { label: "Folder", lines: [detail.path] },
      { label: "Latest version", lines: [detail.latest ?? "none published"] },
      {
        label: flags.installed ? "Installed version" : "Pinned version",
        lines: [detail.pinned ?? "this project pins none"],
      },
      ...factIf(
        "Linked",
        detail.linkedPath === undefined
          ? undefined
          : `builds currently read this recipe from the checkout at ${detail.linkedPath}`
      ),
      { label: "Subscribed", lines: [detail.subscribed ? "yes" : "no"] },
      ...factIf("Described below", detail.describing),
    ]);

    printBrowsingNotes({ notChecked: notChecked.filter((name) => name === detail.repo) });

    this.printVersions(detail.versions);
    this.printDependencies(
      detail.dependencies,
      detail.manifestRead || detail.dependenciesRecorded
    );

    const preview = await this.preview(service, inputs, detail);
    if (typeof preview === "string") {
      blankLine();
      paragraph(preview);
    } else {
      this.printInstalls(preview);
      this.printQuestions(preview);
    }

    if (detail.manifestRead) {
      this.printContents(detail.contents);
    } else {
      blankLine();
      subheading("Where its files land in this project");
      blankLine();
      paragraph(
        "The recipe's own files are not on this machine, so the files it publishes are " +
          "not known here. Subscribing to it fetches them."
      );
    }

    footer();
  }

  /**
   * Works out what subscribing to the described version would install and ask,
   * from the same indexes the rest of the page reads, fetching nothing. The
   * answer is a sentence instead when it cannot be worked out.
   *
   * @param service - The project's subscription service.
   * @param inputs - The catalog's inputs, whose indexes the preview resolves against.
   * @param detail - The recipe being described.
   */
  private async preview(
    service: SubscriptionService,
    inputs: CatalogInputs,
    detail: RecipeDetail
  ): Promise<SubscriptionPreview | string> {
    if (detail.describing === undefined) {
      return (
        "This recipe publishes no version a subscription would install, so nothing " +
        "is described below."
      );
    }
    try {
      return await service.previewSubscription(
        recipeRef(detail.namespace, detail.name, {
          repo: detail.repo,
          range: detail.describing,
        }),
        {
          indexes: new Map(inputs.repos.map((repo) => [repo.name, repo.index])),
          ...(semver.prerelease(detail.describing) === null ? {} : { prerelease: true }),
        }
      );
    } catch (error) {
      return (
        `Sous could not work out what subscribing to version ${detail.describing} ` +
        `would install. ${describeError(error)}`
      );
    }
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
   * What the described version depends on: the manifest entry that brings each
   * dependency in and whether it is a co-subscription or a build dependency,
   * and what its repository's index resolved it to when it was released.
   *
   * @param dependencies - The dependencies the catalog listed.
   * @param known - Whether the manifest or the index says what the version declares.
   */
  private printDependencies(dependencies: RecipeDependencyListing[], known: boolean): void {
    blankLine();
    subheading("What it depends on");
    blankLine();

    if (dependencies.length === 0) {
      paragraph(
        known
          ? "This recipe depends on nothing else."
          : "The repository's index records no dependencies for this version."
      );
      return;
    }

    const rows = dependencies.map((entry) => ({
      key: entry.key,
      declared:
        entry.declared === undefined
          ? "not recorded in the index"
          : describeDeclaration(entry.declared),
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
   * Every recipe a subscription to the described version would install, each
   * with whether its files land in the project and what brings it in, and the
   * repositories it would need that the project does not trust yet.
   *
   * @param preview - What subscribing would install and ask.
   */
  private printInstalls(preview: SubscriptionPreview): void {
    blankLine();
    subheading("What subscribing installs");
    blankLine();

    const rows = preview.resolved.map((recipe) => {
      const subscribed = recipe.requestedBy.includes(PROJECT_REQUESTER);
      const holders = recipe.requestedBy.filter((holder) => holder !== PROJECT_REQUESTER);
      return {
        key: recipe.key,
        version: recipe.version,
        kind: subscribed ? "the subscription itself" : describeDependencyKind(recipe.kind),
        neededBy: holders.length === 0 ? "this subscription" : holders.join(", "),
      };
    });

    for (const line of renderTable(INSTALLS_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }

    if (preview.missingRepos.length > 0) {
      blankLine();
      paragraph(
        `Subscribing also needs ${
          preview.missingRepos.length === 1 ? "a repository" : "repositories"
        } this project does not trust yet, so what ${
          preview.missingRepos.length === 1 ? "it publishes" : "they publish"
        } is not listed above: ` +
          preview.missingRepos
            .map(
              (missing) =>
                `${missing.name}${missing.url === undefined ? "" : ` (${missing.url})`}, ` +
                `needed by ${missing.requiredBy.map((entry) => entry.requestedBy).join(", ")}`
            )
            .join("; ") +
          "."
      );
    }
  }

  /**
   * Every question a subscription to the described version would ask, laid out
   * exactly as `sous subscription add --dry-run` lays them out, without the
   * flags that answer them ahead of time.
   *
   * @param preview - What subscribing would install and ask.
   */
  private printQuestions(preview: SubscriptionPreview): void {
    blankLine();
    subheading("What subscribing asks you");
    blankLine();

    for (const line of formatQuestionPlan(preview.questions, {
      unreadable: preview.unreadable,
      answerHints: false,
    })) {
      log(line === "" ? "" : indent(line));
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

