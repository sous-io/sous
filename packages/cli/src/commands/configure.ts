import { input, confirm } from "@inquirer/prompts";
import fs from "node:fs";
import { BaseCommand } from "../base-command.js";
import {
  PROFILES_DIR,
  loadProfile,
  loadSousConfig,
  saveProfile,
  saveSousConfig,
} from "../lib/user-settings.js";
import { log } from "../utils/formatting.js";

export default class Configure extends BaseCommand {
  static description = "Interactive setup wizard for Sous";

  static examples = ["<%= config.bin %> configure"];

  protected get requiresSettings(): boolean {
    return false;
  }

  async run(): Promise<void> {
    await this.parse(Configure);
    log("Welcome to Sous configuration.\n");

    // --- Profile selection ---
    const currentProfile = this.sousConfig.profile;
    const existingProfiles = this.listProfiles();

    let profileName: string;

    if (existingProfiles.length > 1) {
      profileName = await input({
        message: "Profile name",
        default: currentProfile,
      });
    } else {
      profileName = await input({
        message: "Profile name",
        default: currentProfile,
      });
    }

    profileName = profileName.trim() || currentProfile;

    if (profileName !== currentProfile) {
      const sousConfig = loadSousConfig();
      sousConfig.profile = profileName;
      saveSousConfig(sousConfig);
      log(`Profile set to: ${profileName}`);
    }

    // --- Config path ---
    const profile = loadProfile(profileName);
    const currentPath = profile.defaultConfigPath || "";

    const configPath = await input({
      message: "Path to sous config file (e.g. /path/to/sous.config.local.json)",
      default: currentPath || undefined,
    });

    const resolvedPath = configPath.trim();

    if (!resolvedPath) {
      log("No config path set. Run `xcv configure` again to set one.");
      return;
    }

    if (!fs.existsSync(resolvedPath)) {
      const proceed = await confirm({
        message: `File not found: ${resolvedPath}. Save anyway?`,
        default: false,
      });

      if (!proceed) {
        log("Aborted.");
        return;
      }
    }

    if (resolvedPath !== currentPath) {
      profile.defaultConfigPath = resolvedPath;
      saveProfile(profileName, profile);
      log(`defaultConfigPath → ${resolvedPath}`);
    }

    log("\nConfiguration saved.");
  }

  private listProfiles(): string[] {
    if (!fs.existsSync(PROFILES_DIR)) return [];
    return fs
      .readdirSync(PROFILES_DIR)
      .filter(f => f.endsWith(".profile.json"))
      .map(f => f.replace(/\.profile\.json$/, ""));
  }
}
