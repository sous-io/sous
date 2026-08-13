#!/usr/bin/env node
import { register } from "tsx/esm/api";

// The CLI runs from TypeScript source; register tsx before oclif dynamically
// imports any command module. Resolving "tsx" from this file (rather than a
// $PKG_ROOT/node_modules path) works in every install layout: repo clone,
// global install (nested deps), and local/npx installs (hoisted deps).
register();

const { execute, settings } = await import("@oclif/core");

// tsx (above) already makes .ts imports work, so oclif's own auto-transpile
// machinery is redundant; leaving it on makes every downstream run warn that
// the (unshipped) typescript devDependency is missing.
settings.enableAutoTranspile = false;

await execute({ development: true, dir: import.meta.url });
