/**
 * Which variables hold a secret.
 *
 * A recipe marks a variable `secret: true`, and that declaration is the
 * authority. Everything else in a template's scope (an `_env` mapping, a
 * project `_vars` entry, an answer to a definition that forgot the flag) is
 * checked by a deliberately thin heuristic: a name whose last words say it is
 * a secret (`githubToken`, `OPENAI_API_KEY`, `dbPassword`), or a value in one
 * of the widely used token formats (a GitHub or GitLab token, an AWS access
 * key, a private key block, a URL carrying a password). The heuristic only
 * catches what is very probably a secret; it is a safety net, not a scanner.
 *
 * This module imports nothing, so the template tags can use it without
 * pulling the variables layer into the template engine.
 */

/** What a hidden value shows in place of the secret. */
export const HIDDEN_VALUE = "(hidden)";

/**
 * Name endings that mark a secret, as lowercase words. A name matches when its
 * last words are one of these, so `apiToken` and `GITHUB_TOKEN` match while
 * `tokenLimit` does not.
 */
const SECRET_NAME_ENDINGS: readonly (readonly string[])[] = [
  ["token"],
  ["secret"],
  ["secrets"],
  ["password"],
  ["passwd"],
  ["passphrase"],
  ["credential"],
  ["credentials"],
  ["apikey"],
  ["api", "key"],
  ["private", "key"],
  ["access", "key"],
  ["secret", "key"],
  ["signing", "key"],
  ["encryption", "key"],
];

/** Widely used secret formats, each specific enough that a match is very probably a secret. */
const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // a PEM private key
  /\bgh[pousr]_[A-Za-z0-9]{36,}/, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{22,}/, // GitHub fine-grained token
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab personal access token
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack token
  /\b[rs]k_live_[A-Za-z0-9]{16,}/, // Stripe live key
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic API key
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, // OpenAI API key
  /\bAIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm token
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JSON Web Token
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // a URL carrying a password
];

/** Values a secret-sounding name may hold without being a secret: nothing, a number, a switch. */
const PLAIN_VALUE = /^(?:|-?\d+(?:\.\d+)?|true|false|yes|no|on|off)$/i;

/**
 * The words in a variable name, lowercased: split at `_`, `-`, `.`, spaces and
 * camelCase boundaries, so `OPENAI_API_KEY`, `openaiApiKey` and `openai-api-key`
 * all read as `openai api key`.
 *
 * @param name - The variable name.
 */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

/**
 * Whether a variable name says it holds a secret.
 *
 * @param name - The variable name.
 */
export function hasSecretName(name: string): boolean {
  const words = nameWords(name);
  return SECRET_NAME_ENDINGS.some(
    (ending) =>
      words.length >= ending.length &&
      ending.every((word, i) => words[words.length - ending.length + i] === word)
  );
}

/**
 * Whether a value is in one of the widely used secret formats.
 *
 * @param value - The value.
 */
export function hasSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Whether a variable very probably holds a secret: its name says so (and its
 * value is more than a number or a switch), or its value is in a known secret
 * format.
 *
 * @param name - The variable name.
 * @param value - Its value.
 */
export function looksLikeSecret(name: string, value: string): boolean {
  if (hasSecretValue(value)) return true;
  return hasSecretName(name) && !PLAIN_VALUE.test(value.trim());
}

/**
 * Whether a variable is to be treated as a secret: a recipe declared it one,
 * or the heuristic says it very probably is.
 *
 * @param name - The variable name.
 * @param value - Its value.
 * @param declared - The names recipes declared `secret: true`.
 */
export function isSecretVariable(
  name: string,
  value: unknown,
  declared: ReadonlySet<string> = new Set()
): boolean {
  if (typeof value !== "string") return false;
  if (declared.has(name)) return value.length > 0;
  return looksLikeSecret(name, value);
}
