#!/usr/bin/env node

/**
 * Runner — executes an automation script by absolute path with given params.
 *
 * Usage:
 *   node run.mjs <absolute-path-to-script.mjs> [--param=value ...]
 *
 * Harness options are passed the same way and intercepted before params:
 *   --profileName=<name>   Chrome profile to pull cookies from
 *   --timeout=<ms>         Overall script timeout
 *   --headless=false       (debug) run headed — rarely useful for this system
 *
 * Everything else (--foo=bar) becomes a script param. The harness resolves
 * defaults + settings and validates required params before execute() runs.
 *
 * Project settings compiled by sous (settings.mjs, a sibling of this file) are
 * loaded automatically and passed to the harness as ctx.settings.
 */

import { resolve, dirname, join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const HARNESS_OPTIONS = ['headless', 'profileName', 'timeout'];

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help') {
  console.log('Usage: node run.mjs <absolute-path-to-script.mjs> [--param=value ...]');
  process.exit(args.length === 0 ? 1 : 0);
}

const scriptPath = resolve(args[0]);
if (!existsSync(scriptPath)) {
  console.error(`Script not found: ${scriptPath}`);
  process.exit(1);
}

const { params, options } = parseArgs(args.slice(1));
const settings = await loadSettings();
const script = await import(pathToFileURL(scriptPath).href);
const meta = script.meta || {};

printRunHeader(meta, params, options, settings);

// Imported lazily so --help and arg validation don't require playwright et al.
const { runScript } = await import('./harness.mjs');
const result = await runScript(script, params, { ...options, settings });

reportResult(result);
process.exit(result.success ? 0 : 1);

/**
 * Split `--key=value` args into harness options and script params.
 *
 * @param {string[]} rest - CLI args after the script path.
 * @returns {{params: object, options: object}}
 */
function parseArgs(rest) {
  const params = {};
  const options = {};
  for (const arg of rest) {
    const match = arg.match(/^--([\w-]+)=(.*)$/s);
    if (!match) continue;
    const [, key, value] = match;
    if (!HARNESS_OPTIONS.includes(key)) {
      params[key] = value;
    } else if (key === 'headless') {
      options.headless = value !== 'false';
    } else if (key === 'timeout') {
      options.timeout = parseInt(value, 10);
    } else {
      options[key] = value;
    }
  }
  return { params, options };
}

/**
 * Load compiled project settings (settings.mjs) sitting beside this runner.
 *
 * @returns {Promise<object>} The settings object, or {} if none is present.
 */
async function loadSettings() {
  const here = dirname(fileURLToPath(import.meta.url));
  const settingsPath = join(here, 'settings.mjs');
  if (!existsSync(settingsPath)) return {};
  const mod = await import(pathToFileURL(settingsPath).href);
  return mod.default || {};
}

/**
 * Print the resolved params (with defaults/settings marked) before running.
 *
 * @param {object} meta - The script's meta export.
 * @param {object} params - Explicit CLI params.
 * @param {object} options - Harness options.
 * @param {object} settings - Compiled project settings.
 * @returns {void}
 */
function printRunHeader(meta, params, options, settings) {
  console.log(`\n▶ Running: ${meta.name || '(unnamed script)'}`);
  console.log('  Params:');
  const spec = meta.params || {};
  const keys = new Set([...Object.keys(spec), ...Object.keys(params)]);
  for (const key of keys) {
    let value, origin;
    if (key in params) { value = params[key]; origin = ''; }
    else if (spec[key]?.default !== undefined) { value = spec[key].default; origin = ' (default)'; }
    else if (key in settings) { value = settings[key]; origin = ' (settings)'; }
    else continue;
    console.log(`    ${key}: ${value}${origin}`);
  }
  if (Object.keys(options).length) console.log(`  Options: ${JSON.stringify(options)}`);
  console.log('');
}

/**
 * Print the run outcome and, on success, write any requested output file.
 *
 * @param {object} result - The harness result envelope.
 * @returns {void}
 */
function reportResult(result) {
  console.log('\n' + '─'.repeat(60));
  if (result.success) {
    console.log('✓ Script completed successfully\n');
    if (result.data?.outputFile && result.data?.content) {
      writeFileSync(result.data.outputFile, result.data.content);
      console.log(`Output written to: ${result.data.outputFile}`);
    } else {
      console.log(JSON.stringify(result.data, null, 2));
    }
  } else {
    console.log(`✗ Script failed (${result.error})\n`);
    console.log(result.message);
    if (result.stack && result.error === 'script') console.log(`\nStack:\n${result.stack}`);
    if (result.debugDir) console.log(`\nDebug snapshot (screenshot, HTML, text): ${result.debugDir}`);
  }
}
