#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handOffToProjectInstall, isEnvFlagOn } from "../src/lib/project-install.mjs";

// A project that installs @sous-io/sous itself has pinned the version its
// templates and lockfile were written against, so that copy does the work.
// This runs before anything else is loaded: when a project copy is found, its
// own bin is imported into this process and this one loads nothing further
// (see src/lib/project-install.mjs for the rules, and SOUS_NO_DELEGATE to
// keep the invoked copy running).
const ownRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const handedOff = await handOffToProjectInstall({ ownRoot });

if (!handedOff) {
  // The CLI runs from TypeScript source; register tsx before oclif dynamically
  // imports any command module. Resolving "tsx" from this file (rather than a
  // $PKG_ROOT/node_modules path) works in every install layout: repo clone,
  // global install (nested deps), and local/npx installs (hoisted deps).
  const { register } = await import("tsx/esm/api");
  register();

  const { execute, settings } = await import("@oclif/core");

  // tsx (above) already makes .ts imports work, so oclif's own auto-transpile
  // machinery is redundant; leaving it on makes every downstream run warn that
  // the (unshipped) typescript devDependency is missing.
  settings.enableAutoTranspile = false;

  // oclif's development mode turns on its debug setting, which makes every error
  // it prints a raw stack trace. Sous reports its own errors as sentences (see
  // src/utils/command-errors.ts), so development mode is switched on only when
  // SOUS_DEBUG asks for the traces; anything that gets past a command's own
  // reporting then prints its stack too.
  const debugRequested = isEnvFlagOn(process.env.SOUS_DEBUG);

  await execute({ development: debugRequested, dir: import.meta.url });
}
