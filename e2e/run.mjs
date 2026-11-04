#!/usr/bin/env node
// Host runner: builds the image for each Node version, runs every scenario in a fresh container
// and prints a pass/fail summary.
//
//   node e2e/run.mjs [--version <npm version or tag>] [--node 22|24] [--only <scenario,...>] [--verbose]
//
// Not part of CI; run it by hand with `pnpm e2e`.

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = { version: "latest", node: ["22", "24"], only: null, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) fail(`${arg} needs a value.`);
      return value;
    };
    if (arg === "--version") options.version = next();
    else if (arg === "--node") options.node = next().split(",");
    else if (arg === "--only") options.only = next();
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node e2e/run.mjs [--version <npm version or tag>] [--node 22|24] [--only <scenario,...>] [--verbose]\n",
      );
      process.exit(0);
    } else fail(`Unknown option ${arg}.`);
  }
  return options;
}

function fail(message) {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(2);
}

function tryCommand(command, args) {
  const r = spawnSync(command, args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

// Tokens come from the environment, or else from the gh and glab logins. They go to the
// container as environment variables only; they are never written to a file, an image layer
// or the output.
function collectTokens() {
  const env = {};
  env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || tryCommand("gh", ["auth", "token"]);
  // glab refreshes its OAuth token only when it makes a request, so `config get token` alone can
  // hand over an expired one; one request first makes the stored token current.
  if (!process.env.GITLAB_TOKEN) tryCommand("glab", ["api", "user"]);
  env.GITLAB_TOKEN =
    process.env.GITLAB_TOKEN || tryCommand("glab", ["config", "get", "token", "--host", "gitlab.com"]);
  for (const key of Object.keys(env)) if (!env[key]) delete env[key];
  return env;
}

function scrubber(tokens) {
  const secrets = Object.values(tokens).filter((v) => v.length > 6);
  return (text) => secrets.reduce((acc, s) => acc.split(s).join("***"), text);
}

function dockerBuild(nodeMajor, scrub) {
  const tag = `sous-e2e:node${nodeMajor}`;
  const r = spawnSync("docker", ["build", "-q", "--build-arg", `NODE=${nodeMajor}`, "-t", tag, here], {
    encoding: "utf8",
  });
  if (r.status !== 0) fail(`docker build failed for Node ${nodeMajor}:\n${scrub(r.stderr)}`);
  return tag;
}

function runContainer({ tag, nodeMajor, options, tokens, runId, scrub }) {
  return new Promise((resolve) => {
    const args = ["run", "--rm", "-v", `${here}:/e2e:ro`, "-e", "GITHUB_TOKEN", "-e", "GITLAB_TOKEN"];
    args.push("-e", `SOUS_VERSION=${options.version}`, "-e", `E2E_RUN_ID=${runId}-n${nodeMajor}`);
    if (options.only) args.push("-e", `E2E_ONLY=${options.only}`);
    args.push(tag, "node", "/e2e/container-main.mjs");
    const child = spawn("docker", args, { env: { ...process.env, ...tokens } });
    const events = [];
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.startsWith("@@E2E ")) events.push(JSON.parse(line.slice(6)));
        else if (options.verbose) process.stderr.write(`[node ${nodeMajor}] ${scrub(line)}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (options.verbose) process.stderr.write(scrub(chunk.toString()));
    });
    child.on("close", (code) => resolve({ nodeMajor, events, code, stderr: scrub(stderr) }));
  });
}

function summarize(result) {
  const out = process.stdout;
  const info = result.events.find((e) => e.kind === "info");
  const fatal = result.events.find((e) => e.kind === "fatal");
  out.write(`\nNode ${result.nodeMajor}${info ? ` (${info.node}, sous ${info.sous})` : ""}\n`);
  if (fatal) {
    out.write(`  FATAL: ${fatal.error}\n`);
    return { pass: 0, fail: 1, skip: 0 };
  }
  const totals = { pass: 0, fail: 0, skip: 0 };
  for (const scenario of result.events.filter((e) => e.kind === "scenario")) {
    const counts = { pass: 0, fail: 0, skip: 0 };
    for (const step of scenario.steps) counts[step.status] += 1;
    for (const k of Object.keys(counts)) totals[k] += counts[k];
    const mark = counts.fail ? "FAIL" : counts.pass ? "PASS" : "SKIP";
    out.write(`  ${mark}  ${scenario.name}  (${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped)\n`);
    for (const step of scenario.steps) {
      if (step.status === "fail") out.write(`      FAIL  ${step.step}\n${indent(step.error, "            ")}\n`);
      if (step.status === "skip") out.write(`      SKIP  ${step.step}: ${step.reason}\n`);
    }
  }
  if (!result.events.some((e) => e.kind === "done")) {
    out.write(`  The container ended early (exit ${result.code}).\n${indent(result.stderr.slice(-1500), "    ")}\n`);
    totals.fail += 1;
  }
  out.write(`  Total: ${totals.pass} passed, ${totals.fail} failed, ${totals.skip} skipped\n`);
  return totals;
}

function indent(text, pad) {
  return String(text)
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

const options = parseArgs(process.argv.slice(2));
if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) fail("Docker is not available.");
const tokens = collectTokens();
const scrub = scrubber(tokens);
process.stdout.write(
  `sous e2e: version ${options.version}, Node ${options.node.join(" and ")}, GitHub token ${tokens.GITHUB_TOKEN ? "present" : "absent"}, GitLab token ${tokens.GITLAB_TOKEN ? "present" : "absent"}\n`,
);
const runId = Date.now().toString(36);
const tags = options.node.map((n) => ({ n, tag: dockerBuild(n, scrub) }));
// One container at a time: the scenarios that push to the shared test repositories must not race.
const results = [];
for (const { n, tag } of tags) {
  results.push(await runContainer({ tag, nodeMajor: n, options, tokens, runId, scrub }));
}
let failed = 0;
for (const result of results) failed += summarize(result).fail;
process.stdout.write(failed ? `\nFAILED: ${failed} failing step(s)\n` : "\nAll steps passed.\n");
process.exit(failed ? 1 : 0);
