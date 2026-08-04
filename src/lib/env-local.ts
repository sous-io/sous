import fs from "node:fs";
import path from "node:path";
import { ENV_LOCAL_NAME } from "./config-discovery.js";

/**
 * Parses `.env.local` style content into a flat key/value map.
 *
 * Supported syntax (deliberately small — this is not a shell):
 *   - `KEY=value`
 *   - `export KEY=value` (the `export ` prefix is ignored)
 *   - `# comment` lines and blank lines are skipped
 *   - single- or double-quoted values are unquoted; `\n` and `\t` inside
 *     double quotes become real newlines/tabs
 *   - an unquoted value has a trailing ` # comment` stripped and is trimmed
 *
 * Lines that do not contain `=` are ignored rather than treated as errors, so a
 * stray note in the file cannot break a build.
 *
 * @param content - Raw file contents.
 * @returns Parsed variables in file order (later duplicates win).
 */
export function parseEnvLocal(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    result[key] = parseValue(withoutExport.slice(eq + 1));
  }

  return result;
}

/**
 * Unquotes and cleans up the right-hand side of a `KEY=value` line.
 */
function parseValue(raw: string): string {
  const trimmed = raw.trim();

  if (trimmed.startsWith('"')) {
    const end = findClosingQuote(trimmed, '"');
    if (end !== -1) {
      return trimmed
        .slice(1, end)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"');
    }
  }

  if (trimmed.startsWith("'")) {
    const end = findClosingQuote(trimmed, "'");
    if (end !== -1) return trimmed.slice(1, end);
  }

  // Unquoted: strip an inline comment, then trim.
  const commentAt = trimmed.search(/\s#/);
  const body = commentAt === -1 ? trimmed : trimmed.slice(0, commentAt);
  return body.trim();
}

/**
 * Finds the index of the closing quote for a value that starts with `quote`,
 * skipping backslash-escaped quotes. Returns -1 when unterminated.
 */
function findClosingQuote(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") {
      i++;
      continue;
    }
    if (value[i] === quote) return i;
  }
  return -1;
}

/** The outcome of an attempted `.env.local` load. */
export type EnvLocalLoadResult = {
  /** Absolute path checked. */
  filePath: string;
  /** True when the file existed and was read. */
  loaded: boolean;
  /** Names of variables that were injected into process.env. */
  applied: string[];
  /** Names present in the file but already set in the environment (left alone). */
  skipped: string[];
};

/**
 * Loads `<sousDir>/.env.local` into `process.env`, if it exists.
 *
 * Existing environment values always win: a variable already set in the real
 * environment is never overwritten, so `FOO=bar xcv build` behaves as expected.
 * Must be called before any config or variable resolution so the `_env` block
 * sees the injected values.
 *
 * @param sousDir - The discovered `.sous/` directory.
 * @param env - The environment object to mutate (injectable for tests).
 * @returns What was found and what was applied.
 */
export function loadEnvLocal(
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): EnvLocalLoadResult {
  const filePath = path.join(sousDir, ENV_LOCAL_NAME);

  if (!fs.existsSync(filePath)) {
    return { filePath, loaded: false, applied: [], skipped: [] };
  }

  const parsed = parseEnvLocal(fs.readFileSync(filePath, "utf8"));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { filePath, loaded: true, applied, skipped };
}
