// Runs inside the container: installs sous, then runs each scenario against a fresh machine.
// Prints one `@@E2E {json}` line per step; the host runner reads those lines.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createScenarioContext, scrub } from "./lib/harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// Resolve a tag or range to one exact version first, so every install in the run (npm, pnpm,
// Yarn) gets the same release even while the registry's caches catch up with a new publish.
const requested = process.env.SOUS_VERSION || "latest";
const resolved = spawnSync("npm", ["view", `@sous-io/sous@${requested}`, "version", "--json"], { encoding: "utf8" });
let version = requested;
try {
  const parsed = JSON.parse(resolved.stdout);
  version = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
} catch {
  /* fall back to the request as given; the install below reports the problem */
}
const only = process.env.E2E_ONLY ? process.env.E2E_ONLY.split(",") : null;
const emit = (obj) => process.stdout.write(`@@E2E ${JSON.stringify(obj)}\n`);

// A GitLab OAuth token (what `glab auth login` stores) is a Bearer token; glab sends GITLAB_TOKEN
// as a private token and gets a 401. When the token only works as Bearer, hand it over as
// OAUTH_TOKEN instead, which glab and the git credential helper both read.
if (process.env.GITLAB_TOKEN) {
  const probe = async (headers) =>
    (await fetch("https://gitlab.com/api/v4/user", { headers }).catch(() => ({ status: 0 }))).status;
  const token = process.env.GITLAB_TOKEN;
  if ((await probe({ "PRIVATE-TOKEN": token })) === 401 && (await probe({ Authorization: `Bearer ${token}` })) === 200) {
    process.env.E2E_GITLAB_BEARER = token;
    delete process.env.GITLAB_TOKEN;
  }
}

// One shared install of sous for scenarios that only need a `sous` on PATH. Scenarios about
// installing and updating make their own project installs.
const prefix = "/opt/sous";
fs.mkdirSync(prefix, { recursive: true });
const install = spawnSync("npm", ["i", "--no-audit", "--no-fund", "--prefix", prefix, `@sous-io/sous@${version}`], {
  encoding: "utf8",
});
if (install.status !== 0) {
  emit({ kind: "fatal", error: scrub(`npm i @sous-io/sous@${version} failed:\n${install.stderr}`) });
  process.exit(2);
}
process.env.PATH = `${prefix}/node_modules/.bin:${process.env.PATH}`;
const sousVersion = spawnSync("sous", ["--version"], { encoding: "utf8" }).stdout.trim();
emit({ kind: "info", node: process.version, sous: sousVersion });

const files = fs
  .readdirSync(path.join(here, "scenarios"))
  .filter((f) => f.endsWith(".mjs"))
  .sort();

for (const file of files) {
  const mod = (await import(pathToFileURL(path.join(here, "scenarios", file)).href)).default;
  if (only && !only.some((o) => mod.name === o || file.startsWith(o))) continue;
  const t = createScenarioContext(mod.name);
  t.sousVersion = sousVersion;
  t.requestedVersion = version;
  try {
    await mod.run(t);
  } catch (error) {
    t.results.push({ step: "(scenario crashed)", status: "fail", error: scrub(error?.stack ?? error), ms: 0 });
  }
  emit({ kind: "scenario", name: mod.name, title: mod.title ?? mod.name, steps: t.results });
}
emit({ kind: "done" });
