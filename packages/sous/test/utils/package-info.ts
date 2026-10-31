import { readFileSync } from "node:fs";
import path from "node:path";

/** The version of the sous package under test, as its package.json says. */
export const SOUS_VERSION: string = (
    JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "package.json"), "utf8")) as { version: string }
).version;
