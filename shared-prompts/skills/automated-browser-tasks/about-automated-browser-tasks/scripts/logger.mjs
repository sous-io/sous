/**
 * Logger
 *
 * Plain prefixed-line logger for automation scripts. Output format:
 *   [script-name] message
 *   [script-name:section] message   (from a child logger)
 *
 * warn/error are routed to stderr and tagged with their level.
 */

/**
 * Create a logger for a script. `child(section)` returns a logger whose
 * prefix is extended with `:section`.
 *
 * @param {string} prefix - Initial prefix (usually the script's meta.name)
 * @returns {{info: Function, warn: Function, error: Function, child: Function}}
 */
export function createLogger(prefix) {
  return {
    info: (msg) => console.log(`[${prefix}] ${msg}`),
    warn: (msg) => console.warn(`[${prefix}] WARN ${msg}`),
    error: (msg) => console.error(`[${prefix}] ERROR ${msg}`),
    child: (section) => createLogger(`${prefix}:${section}`),
  };
}
