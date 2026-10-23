/**
 * PROOF OF CONCEPT for `sous serve`. The project's config layers, in merge
 * order, with what each one changes and which layer gave each setting its final
 * value: the same trace `sous config get --layers` reads.
 */
import fs from "node:fs";
import path from "node:path";
import type { DiscoveredConfig } from "../config-discovery.js";
import { loadSettingsWithLayers } from "../settings.js";

export type LayerChange = { key: string; value: string; was?: string };

export type ConfigLayerInfo = {
  path: string;
  /** Path shown to people: relative to the project when it's inside it. */
  display: string;
  kind: "primary" | "conf.d" | "recipe" | "other";
  changes: LayerChange[];
  /** The file's own text, when it can be read (secrets masked). */
  text?: string;
};

export type ConfigReport = {
  layers: ConfigLayerInfo[];
  /** Every final setting, flattened, with the layer that set it. */
  settings: { key: string; value: string; layer: string }[];
};

const SECRET_KEY = /(secret|token|password|api[_-]?key|private)/i;

function flatten(value: unknown, prefix = "", out = new Map<string, string>()): Map<string, string> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && prefix) out.set(prefix, "{}");
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    const text = JSON.stringify(value);
    out.set(prefix, SECRET_KEY.test(prefix) ? '"••••••"' : text.length > 300 ? `${text.slice(0, 300)}…` : text);
  }
  return out;
}

export async function configReport(discovered: DiscoveredConfig, projectRoot: string, merged: unknown): Promise<ConfigReport> {
  const { layers } = await loadSettingsWithLayers(discovered, { trace: true });
  const result: ConfigLayerInfo[] = [];
  const setBy = new Map<string, string>();
  let previous = new Map<string, string>();

  for (const layer of layers) {
    const current = flatten(layer.config);
    const changes: LayerChange[] = [];
    for (const [key, value] of current) {
      const was = previous.get(key);
      if (was !== value) {
        changes.push({ key, value, ...(was !== undefined ? { was } : {}) });
        setBy.set(key, layer.path);
      }
    }
    const rel = path.relative(projectRoot, layer.path);
    const display = rel.startsWith("..") ? layer.path : rel;
    const kind = layer.path === discovered.configPath ? "primary" : layer.path.includes(`${path.sep}conf.d${path.sep}`) ? "conf.d" : layer.path.includes(".sous") && layer.path.includes("cache") ? "recipe" : "other";
    let text: string | undefined;
    try {
      text = fs
        .readFileSync(layer.path, "utf8")
        .split("\n")
        .map((line) => (SECRET_KEY.test(line) && /[:=]/.test(line) ? line.replace(/([:=]\s*).+$/, "$1••••••") : line))
        .join("\n");
    } catch {
      // A layer handed over as content (a recipe layer) has no file to show.
    }
    result.push({ path: layer.path, display, kind, changes, text });
    previous = current;
  }

  // The final values come from the merged settings: a layer that sets values
  // through configure() can leave keys out of its trace snapshot.
  const final = flatten(merged);
  const primary = result.find((l) => l.kind === "primary");
  if (primary) {
    for (const [key, value] of final) {
      if (!setBy.has(key)) {
        primary.changes.push({ key, value });
        setBy.set(key, primary.path);
      }
    }
  }
  const settings = [...final.entries()].map(([key, value]) => {
    const layer = setBy.get(key) ?? "";
    const rel = path.relative(projectRoot, layer);
    return { key, value, layer: rel.startsWith("..") ? layer : rel };
  });
  return { layers: result, settings };
}
