import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { runProjectBuild } from "../lib/build-service.js";
import { PidService } from "../lib/pid-service.js";
import { resolveRootScope } from "../lib/settings.js";
import { resolveStoreSettings } from "../lib/repos/store/settings.js";
import { subscriptionServiceFor } from "../lib/repos/subscription-service.js";
import { buildReloadWatchConfig, startConfigReloadWatch } from "../lib/watch-loop.js";
import type { WatchHandle } from "../lib/watch-service.js";
import { WatchService } from "../lib/watch-service.js";
import { log, paragraph, showCommandVars } from "../utils/formatting.js";

export default class Build extends BaseCommand {
  static description =
    "Compile this project's outputs and remove the ones its config no longer produces";

  static examples = [
    "<%= config.bin %> build",
    "<%= config.bin %> build --no-prune",
    "<%= config.bin %> build --rebuild",
    "<%= config.bin %> build --dry-run",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    "no-prune": Flags.boolean({
      description: "Skip the prune step",
      default: false,
    }),
    "no-compile": Flags.boolean({
      description: "Skip the compile step (prune only)",
      default: false,
    }),
    rebuild: Flags.boolean({
      description: "Ignore cached hashes and reprocess all outputs",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be written/pruned without making changes",
      default: false,
    }),
    strict: Flags.boolean({
      description: "Treat compile warnings as errors",
      default: false,
    }),
    watch: Flags.boolean({
      char: "w",
      description: "Watch source files and rebuild on changes",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Build);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Rebuild: flags.rebuild,
      "Dry Run": flags["dry-run"],
      "No Compile": flags["no-compile"],
      "No Prune": flags["no-prune"],
    });

    const buildOptions = {
      strict: flags.strict,
      rebuild: flags.rebuild,
      dryRun: flags["dry-run"],
      noCompile: flags["no-compile"],
      noPrune: flags["no-prune"],
    };

    const success = await runProjectBuild({
      settings: this.settings,
      configContext: this.configContext,
      shellEnv: this.shellEnv,
      options: buildOptions,
    });

    if (!success && !flags.watch) {
      this.exit(1);
    }

    if (flags.watch) {
      const rootScope = resolveRootScope(this.settings, this.configContext);

      // --- PID file enforcement ---
      const pidService = new PidService();
      const pidFilePath = pidService.getFilePath(rootScope);
      await pidService.acquire(pidFilePath, this.projectLabel);

      const cleanup = async (watchHandle?: WatchHandle) => {
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        process.stdin.pause();
        if (watchHandle) await watchHandle.stop();
        await pidService.release(pidFilePath);
      };

      process.on("SIGINT", () => { void cleanup().then(() => process.exit(0)); });
      process.on("SIGTERM", () => { void cleanup().then(() => process.exit(0)); });

      const watchService = new WatchService();

      // Reruns the build with the command's current settings. Called for
      // partial rebuilds (with the changed file) and, after a clean reload, for
      // full rebuilds, which prepare the recipes again the way the first build did.
      const rebuild = async (changedFile?: string) => {
        // A failed rebuild has already listed its errors, and the watch keeps
        // running so the next save can fix them.
        await runProjectBuild({
          settings: this.settings,
          configContext: this.configContext,
          shellEnv: this.shellEnv,
          heading: "Rebuilding",
          options: {
            ...buildOptions,
            // --rebuild means full clean build on every trigger; skip partial optimisation
            changedFile: buildOptions.rebuild ? undefined : changedFile,
          },
        });
      };

      const { handle, triggerFullRebuild } = startConfigReloadWatch({
        watchService,
        buildWatchConfig: () => buildReloadWatchConfig(this.settings, this.configContext),
        rebuild,
        reloadConfig: () => this.reloadDiscoveredConfig(),
      });

      // Watch mode polls upstream for the repositories that prefer a newer
      // in-range version. The poll is cheap (one index request per repository)
      // and a failure never breaks the watch; the last good answer stands.
      const pollSeconds = resolveStoreSettings(this.settings).watchPollSeconds;
      if (pollSeconds > 0) {
        const repositories = subscriptionServiceFor({
          configContext: this.configContext,
          settings: this.settings,
          shellEnv: this.shellEnv,
        });
        const poll = setInterval(() => {
          void repositories
            .checkUpstream()
            .then(async (report) => {
              if (report.updated.length === 0) return;
              for (const change of report.updated) {
                paragraph(`  ${change.key} moved from ${change.from} to ${change.to}.`);
              }
              await triggerFullRebuild("A newer recipe version arrived upstream.");
            })
            .catch(() => {
              // checkUpstream already reports its own failures as warnings.
            });
        }, pollSeconds * 1000);
        poll.unref();
      }

      // Display the interactive prompt
      log("[ Press Q to quit  |  any other key: rebuild ]");

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");

        process.stdin.on("data", (key: string) => {
          // q, Q, or Ctrl+C → clean exit
          if (key === "q" || key === "Q" || key === "\u0003") {
            void cleanup(handle.current ?? undefined).then(() => process.exit(0));
            return;
          }
          // Any other key → trigger a full rebuild immediately (bypass debounce)
          void triggerFullRebuild("Manual rebuild triggered.");
        });
      }

      await new Promise(() => {}); // keep process alive
    }
  }
}
