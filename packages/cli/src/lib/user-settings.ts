import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Root of all Sous user data: ~/.sous */
export const SOUS_HOME = path.join(os.homedir(), ".sous");

/** ~/.sous/settings */
export const SETTINGS_DIR = path.join(SOUS_HOME, "settings");

/** ~/.sous/settings/profiles */
export const PROFILES_DIR = path.join(SETTINGS_DIR, "profiles");

/** ~/.sous/settings/sous.config.json */
export const SOUS_CONFIG_PATH = path.join(SETTINGS_DIR, "sous.config.json");

/** Global Sous configuration (profile selection, etc.) */
export type SousConfig = {
  /** Active profile name. Defaults to "default". */
  profile: string;
};

/** Per-profile configuration */
export type ProfileConfig = {
  /** Absolute path to the project settings file (.js or .json). Empty = not set. */
  defaultConfigPath: string;
};

/**
 * Ensures ~/.sous/settings/profiles/ exists.
 * Called at the start of every command.
 */
export function ensureSousHome(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

/**
 * Loads ~/.sous/settings/sous.config.json.
 * Creates it with defaults if it does not exist.
 */
export function loadSousConfig(): SousConfig {
  if (!fs.existsSync(SOUS_CONFIG_PATH)) {
    const defaults: SousConfig = { profile: "default" };
    fs.writeFileSync(SOUS_CONFIG_PATH, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
  return JSON.parse(fs.readFileSync(SOUS_CONFIG_PATH, "utf8")) as SousConfig;
}

/** Saves the global Sous config. */
export function saveSousConfig(config: SousConfig): void {
  fs.writeFileSync(SOUS_CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

/** Returns the absolute path to a named profile file. */
export function getProfilePath(name: string): string {
  return path.join(PROFILES_DIR, `${name}.profile.json`);
}

/**
 * Loads a profile by name.
 * Creates it with empty defaults if it does not exist.
 */
export function loadProfile(name: string): ProfileConfig {
  const profilePath = getProfilePath(name);
  if (!fs.existsSync(profilePath)) {
    const defaults: ProfileConfig = { defaultConfigPath: "" };
    fs.writeFileSync(profilePath, JSON.stringify(defaults, null, 2), "utf8");
    return defaults;
  }
  return JSON.parse(fs.readFileSync(profilePath, "utf8")) as ProfileConfig;
}

/** Saves a profile by name. */
export function saveProfile(name: string, config: ProfileConfig): void {
  const profilePath = getProfilePath(name);
  fs.writeFileSync(profilePath, JSON.stringify(config, null, 2), "utf8");
}
