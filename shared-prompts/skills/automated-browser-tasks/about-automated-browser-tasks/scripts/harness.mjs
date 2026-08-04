/**
 * Execution Harness
 *
 * Launches headless Playwright with cookies extracted from a Chrome profile.
 * Handles auth detection, structured output, and error reporting.
 */

import { chromium } from 'playwright';
import { buildStorageState } from './chrome-state.mjs';
import { createLogger } from './logger.mjs';
import { createUtils } from './utils.mjs';
import { createDebug } from './debug.mjs';
import { resolveParams, ParamError } from './params.mjs';

export class AuthError extends Error {
  constructor(message, { url, indicators } = {}) {
    super(message);
    this.name = 'AuthError';
    this.url = url;
    this.indicators = indicators || [];
  }
}

/**
 * Run an automation script with Chrome session state injected.
 *
 * @param {object} script - The script module (must export `execute` and `meta`)
 * @param {object} params - Explicit parameters (e.g. from CLI)
 * @param {object} options - Harness options
 * @param {string} options.profileName - Chrome profile name (default: 'Default')
 * @param {string[]} options.domains - Limit cookie extraction to these domain substrings
 * @param {number} options.timeout - Overall timeout in ms (default: 60000)
 * @param {object} options.settings - Compiled project settings (ctx.settings)
 */
export async function runScript(script, params = {}, options = {}) {
  const {
    profileName = 'Default',
    domains = null,
    timeout = 60000,
    settings = {},
  } = options;

  const meta = script.meta || {};
  const sessionLog = createLogger('session');

  let browser = null;
  let debug = null;

  try {
    // Resolve + validate params BEFORE launching anything. A script never
    // validates its own input; a ParamError here surfaces before browser work.
    const resolvedParams = resolveParams(meta, params, settings);

    sessionLog.info(`Extracting cookies from Chrome profile: "${profileName}"`);
    const storageState = await buildStorageState(profileName, domains);
    sessionLog.info(`Extracted ${storageState.cookies.length} cookies`);
    if (domains) {
      sessionLog.info(`Filtered to domains: ${domains.join(', ')}`);
    }

    sessionLog.info('Launching headless browser...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const context = await browser.newContext({
      storageState,
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    sessionLog.info('Browser ready\n');

    const logger = createLogger(meta.name || 'script');
    debug = createDebug(page, logger, { runId: meta.name || 'script' });

    const ctx = {
      page,
      context,
      browser,
      params: resolvedParams,
      settings,
      timeout,
      logger,
      utils: createUtils(page, logger),
      debug,

      async checkAuth() {
        const currentUrl = page.url();
        const authIndicators = [
          '/login', '/auth/', '/sso', 'signin', 'multipass',
          'accounts.google.com', 'login.microsoftonline.com',
        ];

        for (const indicator of authIndicators) {
          if (currentUrl.includes(indicator)) {
            throw new AuthError(
              `Authentication required. The browser was redirected to a login page.\n` +
              `Current URL: ${currentUrl}\n\n` +
              `Action needed: Log in to the target site in your Chrome browser ` +
              `(profile: "${profileName}"), then retry this script.`,
              { url: currentUrl, indicators: [indicator] }
            );
          }
        }
      },

      async runChild(childScript, childParams = {}) {
        const childMeta = childScript.meta || {};
        const childResolved = resolveParams(childMeta, childParams, settings);
        const childLogger = createLogger(childMeta.name || 'child');
        const childCtx = {
          ...ctx,
          params: childResolved,
          logger: childLogger,
          utils: createUtils(page, childLogger),
          debug: createDebug(page, childLogger, { runId: childMeta.name || 'child' }),
        };
        return childScript.execute(childCtx);
      },
    };

    const result = await Promise.race([
      script.execute(ctx),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Script timed out after ${timeout}ms`)), timeout)
      ),
    ]);

    return { success: true, data: result };
  } catch (error) {
    if (error instanceof ParamError) {
      return { success: false, error: 'params', message: error.message };
    }

    if (error instanceof AuthError) {
      return {
        success: false,
        error: 'auth',
        message: error.message,
        url: error.url,
        indicators: error.indicators,
      };
    }

    // Auto-capture page state on an unexpected script failure — the single most
    // useful debugging artifact. Done before `finally` closes the browser.
    let debugDump = null;
    if (debug) {
      const snapshot = await debug.dump('failure').catch(() => null);
      debugDump = snapshot?.dir || null;
    }

    return {
      success: false,
      error: 'script',
      message: error.message,
      stack: error.stack,
      debugDir: debugDump,
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
