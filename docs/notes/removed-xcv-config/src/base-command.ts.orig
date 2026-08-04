import { Command, Flags } from "@oclif/core";
import fs from "node:fs";
import {
  ensureSousHome,
  loadProfile,
  loadSousConfig,
  type ProfileConfig,
  type SousConfig,
} from "./lib/user-settings.js";
import { loadSettings, type RawProject, type Settings } from "./lib/settings.js";
import { displayError, header } from "./utils/formatting.js";

/**
 * Base class for all CLI commands.
 * Bootstraps ~/.sous/ on every run, loads user config + profile,
 * then loads project settings from the profile's defaultConfigPath.
 */
export abstract class BaseCommand extends Command {
  static baseFlags = {
    project: Flags.string({
      char: "p",
      description: "Project key to operate on",
    }),
  };

  protected settings!: Settings;
  protected sousConfig!: SousConfig;
  protected profile!: ProfileConfig;
  protected profileName!: string;

  /**
   * Override to false in commands that do not require project settings
   * (e.g. xcv config get/set).
   */
  protected get requiresSettings(): boolean {
    return true;
  }

  async init(): Promise<void> {
    await super.init();
    header();

    ensureSousHome();

    this.sousConfig = loadSousConfig();
    this.profileName = this.sousConfig.profile;
    this.profile = loadProfile(this.profileName);

    if (this.requiresSettings) {
      if (!this.profile.defaultConfigPath) {
        displayError(
          "Default config file not set. To set it, use:\nxcv config set defaultConfigPath <path>"
        );
        this.exit(1);
      }

      if (!fs.existsSync(this.profile.defaultConfigPath)) {
        displayError(`Config file not found: ${this.profile.defaultConfigPath}`);
        this.exit(1);
      }

      this.settings = await loadSettings(this.profile.defaultConfigPath);
    }
  }

  /**
   * Resolves the active project from the --project flag or settings.defaultProject.
   * Exits with an error if no project key is available or the key is not found.
   */
  protected resolveProject(flagValue: string | undefined): RawProject & { key: string } {
    const key = flagValue ?? this.settings.defaultProject;

    if (!key) {
      displayError(
        "No project specified. Use --project <key> or set defaultProject in your config file"
      );
      this.exit(1);
    }

    const project = this.settings.projects?.[key!];

    if (!project) {
      displayError(`Project '${key}' not found in config file`);
      this.exit(1);
    }

    return { ...project!, key: key! };
  }
}
