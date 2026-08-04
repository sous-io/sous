/**
 * ctx.utils — generic, site-agnostic helpers for automation scripts.
 *
 * These are the patterns proven during the POC, promoted out of any single
 * script. Site-specific logic (dismissing a particular app's modals, parsing a
 * particular tool's output) stays in the script as step functions.
 *
 * Built per-run and bound to the live `page`/`logger`, so scripts call them as
 * `ctx.utils.foo(...)` without threading `page` through every call.
 */

/**
 * Build the utils object for a run.
 *
 * @param {import('playwright').Page} page
 * @param {object} logger - The script's logger (a child is created per helper)
 * @returns {object} the ctx.utils surface
 */
export function createUtils(page, logger) {
  const log = logger.child('utils');

  return {
    /**
     * RECOMMENDED way to handle modals/banners that appear at an unpredictable
     * time and would block later actions. Registers a Playwright locator handler:
     * whenever `triggerLocator` is present and blocks an action, `dismiss` runs.
     * This is fully timing-independent — no sleeps, no races. Prefer this over
     * `dismissModals` for anything that may appear asynchronously.
     *
     * @param {import('playwright').Locator} triggerLocator - The modal/overlay.
     * @param {(locator) => Promise<void>} dismiss - How to dismiss it.
     * @returns {Promise<void>}
     */
    async autoDismiss(triggerLocator, dismiss) {
      await page.addLocatorHandler(triggerLocator, dismiss);
      log.info('registered auto-dismiss handler');
    },

    /**
     * Best-effort one-shot dismissal of modals KNOWN to already be present. Clicks
     * the first of each candidate selector that currently exists; failures are
     * swallowed. Does NOT wait for modals that may appear later — use
     * `autoDismiss` for those. No fixed delays.
     *
     * @param {string[]} selectors
     * @param {object} [opts] - { timeout }
     * @returns {Promise<number>} count of elements clicked
     */
    async dismissModals(selectors, opts = {}) {
      const { timeout = 2000 } = opts;
      let dismissed = 0;
      for (const sel of selectors) {
        const el = await page.$(sel);
        if (!el) continue;
        try {
          await el.click({ timeout });
          dismissed++;
        } catch {
          // best-effort; modal may have already closed or be non-actionable
        }
      }
      if (dismissed) log.info(`dismissed ${dismissed} modal element(s)`);
      return dismissed;
    },

    /**
     * Click an element located by visible text (regex or string). Defaults to a
     * NON-forced click so Playwright auto-waits for the element to be actionable
     * (visible, stable, not covered) — the resilient default. Pass `force: true`
     * only for the rare element a component library (e.g. Blueprint.js) wrongly
     * reports as disabled, and verify the outcome afterward.
     *
     * @param {RegExp|string} text
     * @param {object} [opts] - { force, timeout }
     */
    async clickByText(text, opts = {}) {
      const { force = false, timeout = 15000 } = opts;
      const locator = page.getByText(text).first();
      await locator.waitFor({ timeout });
      await locator.click({ force });
    },

    /**
     * Wait for any element matching `text` (regex or string) to appear, without
     * clicking. Useful for asserting a list/view has rendered.
     *
     * @param {RegExp|string} text
     * @param {object} [opts] - { timeout }
     */
    async waitForText(text, opts = {}) {
      const { timeout = 15000 } = opts;
      await page.getByText(text).first().waitFor({ timeout });
    },

    /**
     * Try each selector in order; return the longest text content found among
     * all matches, or null if nothing exceeds `minLength`. Built for "find the
     * log/output blob on the page" cases where the exact container is unknown.
     *
     * @param {string[]} selectors
     * @param {object} [opts] - { minLength }
     * @returns {Promise<string|null>}
     */
    async extractLongestText(selectors, opts = {}) {
      const { minLength = 50 } = opts;
      for (const sel of selectors) {
        const els = await page.$$(sel);
        if (!els.length) continue;
        const texts = await Promise.all(els.map((el) => el.textContent()));
        const longest = texts
          .filter(Boolean)
          .map((t) => t.trim())
          .sort((a, b) => b.length - a.length)[0];
        if (longest && longest.length >= minLength) return longest;
      }
      return null;
    },

    /**
     * Extract the first match of a regex from page text (or supplied text).
     * Returns the trimmed match string, or null.
     *
     * @param {RegExp} pattern
     * @param {object} [opts] - { source: string, group: number }
     * @returns {Promise<string|null>}
     */
    async extractTextByPattern(pattern, opts = {}) {
      const { source = null, group = 0 } = opts;
      const haystack = source ?? (await page.textContent('body')) ?? '';
      const m = haystack.match(pattern);
      return m ? m[group].trim() : null;
    },

    /**
     * Capture a screenshot for debugging. No-op-safe: failures are logged, not
     * thrown, so a debug aid never breaks a run.
     *
     * @param {string} path - Absolute file path for the PNG
     * @param {object} [opts] - { fullPage }
     */
    async screenshot(path, opts = {}) {
      const { fullPage = true } = opts;
      try {
        await page.screenshot({ path, fullPage });
        log.info(`screenshot saved: ${path}`);
      } catch (err) {
        log.warn(`screenshot failed: ${err.message}`);
      }
    },

    /**
     * Scroll an element matching `selector` into view. Returns true if found.
     *
     * @param {string} selector
     */
    async scrollIntoView(selector) {
      const el = await page.$(selector);
      if (!el) return false;
      await el.scrollIntoViewIfNeeded().catch(() => {});
      return true;
    },

    /**
     * Retry an async function until it succeeds or attempts are exhausted.
     * Throws the last error on final failure.
     *
     * @param {Function} fn - async () => result
     * @param {object} [opts] - { attempts, delay, label }
     */
    async retry(fn, opts = {}) {
      const { attempts = 3, delay = 1000, label = 'operation' } = opts;
      let lastErr;
      for (let i = 1; i <= attempts; i++) {
        try {
          return await fn();
        } catch (err) {
          lastErr = err;
          log.warn(`${label} failed (attempt ${i}/${attempts}): ${err.message}`);
          if (i < attempts) await page.waitForTimeout(delay);
        }
      }
      throw lastErr;
    },
  };
}
