/**
 * Param resolution and validation.
 *
 * Scripts declare their params in `meta.params`. The framework resolves and
 * validates them BEFORE `execute()` runs, so a script never validates its own
 * input.
 *
 * Resolution order (lowest to highest priority):
 *   ctx.settings  <  meta.params[x].default  <  explicit (CLI) params
 *
 * A param spec supports:
 *   required        {boolean}  - error if no value resolves
 *   default         {*}        - fallback value
 *   description     {string}   - shown in CLI listings and error messages
 *   validate        {RegExp|Function}
 *       RegExp   - the resolved value (coerced to string) must match
 *       Function - (value, resolvedParams) => true | false | string
 *                  true   = valid
 *                  string = invalid; the string is used as the error message
 *                  false  = invalid; `invalidMessage` (or a default) is used
 *   invalidMessage  {string}   - error message for a failing RegExp, or for a
 *                                validate function that returns `false`
 */

export class ParamError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParamError';
  }
}

/**
 * Resolve and validate params for a script.
 *
 * @param {object} meta - The script's `meta` export (may have `.params`).
 * @param {object} explicit - Params explicitly provided (e.g. from CLI).
 * @param {object} settings - Compiled project settings (ctx.settings).
 * @returns {object} The fully-resolved params object.
 * @throws {ParamError} If a required param is missing or a value fails validation.
 */
export function resolveParams(meta, explicit = {}, settings = {}) {
  const spec = meta?.params || {};
  const scriptName = meta?.name || 'script';
  const resolved = {};
  const missing = [];

  for (const [key, def] of Object.entries(spec)) {
    let value;
    if (key in explicit) value = explicit[key];
    else if (def.default !== undefined) value = def.default;
    else if (key in settings) value = settings[key];

    if (value === undefined) {
      if (def.required) missing.push(key);
      continue;
    }
    resolved[key] = value;
  }

  // Pass through any explicit params not declared in meta (escape hatch).
  for (const [key, value] of Object.entries(explicit)) {
    if (!(key in resolved)) resolved[key] = value;
  }

  if (missing.length) {
    throw new ParamError(
      `Missing required param(s) for "${scriptName}":\n${missing
        .map((k) => describeParam(k, spec[k]))
        .join('\n')}`
    );
  }

  const invalid = validateParams(spec, resolved);
  if (invalid.length) {
    throw new ParamError(
      `Invalid param(s) for "${scriptName}":\n${invalid
        .map(({ key, message }) => `  - ${key}: ${message}`)
        .join('\n')}`
    );
  }

  return resolved;
}

/**
 * Run each declared param's `validate` rule against its resolved value.
 *
 * @param {object} spec - The `meta.params` spec object.
 * @param {object} resolved - The resolved param values.
 * @returns {Array<{key: string, message: string}>} One entry per failure.
 */
function validateParams(spec, resolved) {
  const failures = [];

  for (const [key, def] of Object.entries(spec)) {
    if (!(key in resolved) || !def?.validate) continue;
    const message = runValidator(def, resolved[key], resolved);
    if (message) failures.push({ key, message });
  }

  return failures;
}

/**
 * Apply a single param's validator to a value.
 *
 * @param {object} def - The param spec (has `validate` and optional `invalidMessage`).
 * @param {*} value - The resolved value to check.
 * @param {object} resolved - All resolved params (passed to function validators).
 * @returns {string|null} An error message if invalid, otherwise null.
 */
function runValidator(def, value, resolved) {
  const { validate, invalidMessage } = def;

  if (validate instanceof RegExp) {
    return validate.test(String(value))
      ? null
      : invalidMessage || `value "${value}" does not match ${validate}`;
  }

  if (typeof validate === 'function') {
    const result = validate(value, resolved);
    if (result === true) return null;
    if (typeof result === 'string') return result;
    return invalidMessage || `value "${value}" is invalid`;
  }

  return null;
}

/**
 * Format a param for inclusion in a "missing required" error message.
 *
 * @param {string} key - The param name.
 * @param {object} [def] - The param spec (may carry a description).
 * @returns {string} A single indented line.
 */
function describeParam(key, def) {
  return def?.description ? `  - ${key}: ${def.description}` : `  - ${key}`;
}
