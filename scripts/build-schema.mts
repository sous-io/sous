/**
 * Generates the committed `sous.config.schema.json` artifact at the repo root
 * from the zod `settingsSchema` (src/lib/config-schema.ts).
 *
 * Run via `npm run schema:build` (tsx). Re-run whenever the schema changes so
 * the JSON Schema artifact stays current; it is shipped in the package.json
 * "files" allowlist and can back editor autocompletion / external validation.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { settingsSchema } from "../src/lib/config-schema.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(repoRoot, "sous.config.schema.json");

const jsonSchema = z.toJSONSchema(settingsSchema, { target: "draft-7" }) as Record<
  string,
  unknown
>;
jsonSchema.$id = "https://sous-io.github.io/sous/sous.config.schema.json";
jsonSchema.title = "Sous config";

fs.writeFileSync(outputPath, JSON.stringify(jsonSchema, null, 2) + "\n");
console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
