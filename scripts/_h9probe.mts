import { createEngine } from "../packages/core/src/index.js";
import { BUILT_IN_PLUGINS } from "../packages/sous/src/built-ins.js";
import { toJsonSchema } from "../packages/plugin-api/src/index.js";
const dir = process.argv[2]!;
const engine = createEngine({ env: { HOME: dir }, cwd: dir, app: { name: "sous", version: "0.2.34" }, builtIns: BUILT_IN_PLUGINS });
const built = await engine.buildConfig();
for (const r of built.entities.describe("config-key")) {
  if(!(r as any).entry) { console.log(Object.keys(r)); break; }
  const js = toJsonSchema((r as any).entry.schema);
  console.log((r as any).entry.id, (r as any).plugin, js ? JSON.stringify(js).slice(0, 100) : "NONE");
}
