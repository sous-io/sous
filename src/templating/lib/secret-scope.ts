import type { Liquid } from "liquidjs";
import { HIDDEN_VALUE, isSecretVariable } from "../../lib/vars/secrets.js";

/**
 * The variable names each engine was told are secret. Kept beside the engine
 * rather than in its scope, so the list itself never shows up in a dump.
 */
const secretNamesByEngine = new WeakMap<Liquid, ReadonlySet<string>>();

/**
 * Records the variable names a recipe declared `secret: true` for one engine.
 *
 * @param engine - The engine the tags render with.
 * @param names - The declared names.
 */
export function setSecretNames(engine: Liquid, names: Iterable<string>): void {
  secretNamesByEngine.set(engine, new Set(names));
}

/**
 * The declared secret names for an engine; empty when none were recorded.
 *
 * @param engine - The engine the tags render with.
 */
export function secretNamesFor(engine: Liquid): ReadonlySet<string> {
  return secretNamesByEngine.get(engine) ?? new Set();
}

/**
 * Whether a scope entry is a secret a whole-scope dump must not print: a
 * declared secret, or one the heuristic in `lib/vars/secrets.ts` recognizes.
 *
 * @param engine - The engine the tag renders with.
 * @param name - The variable name.
 * @param value - Its value.
 */
export function isSecretEntry(engine: Liquid, name: string, value: unknown): boolean {
  return isSecretVariable(name, value, secretNamesFor(engine));
}

export { HIDDEN_VALUE };
