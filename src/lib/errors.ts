/**
 * Shared error types for sous.
 *
 * ConfigError lives in its own module (rather than settings.ts) so that
 * config-discovery.ts can throw it without importing settings.ts — settings.ts
 * imports discovery constants, and a back-import would create a cycle.
 * settings.ts re-exports both names for backwards compatibility.
 */

/**
 * A user-facing configuration error: the config file (or environment) is wrong,
 * not the CLI. Commands render these as a plain message with no stack trace,
 * since the stack points at Sous internals and tells the user nothing.
 */
export class ConfigError extends Error {
  readonly isConfigError = true;

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** True when the value is a ConfigError (safe across module instances). */
export function isConfigError(error: unknown): boolean {
  return (
    error instanceof ConfigError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { isConfigError?: boolean }).isConfigError === true)
  );
}
