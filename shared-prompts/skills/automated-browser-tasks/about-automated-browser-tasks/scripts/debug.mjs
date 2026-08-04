/**
 * ctx.debug — exploration & debugging tools for automation scripts.
 *
 * Browser automation fails because authors GUESS about a page (its DOM, its
 * timing) instead of observing it. These tools make observation cheap, so you
 * can build condition-based waits and correct selectors from what is actually
 * on the page. See references/script-conventions.md ("observe the real page").
 *
 * Built per-run and bound to the live `page`/`logger`. Artifacts (screenshots,
 * HTML, snapshots) are written under a per-run debug directory so repeated runs
 * don't clobber each other.
 *
 * Pure formatting helpers (no page I/O) are exported separately so they can be
 * unit-tested without a browser.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * Build the debug toolkit for a run.
 *
 * @param {import('playwright').Page} page
 * @param {object} logger - The script's logger (a child is created internally).
 * @param {object} [opts]
 * @param {string} [opts.dir] - Directory for artifacts. Defaults to a unique
 *   subdir of the OS temp dir.
 * @param {string} [opts.runId] - Identifier mixed into the default dir name.
 * @returns {object} the ctx.debug surface
 */
export function createDebug(page, logger, opts = {}) {
  const log = logger.child('debug');
  const dir = opts.dir || join(tmpdir(), 'sous-browser-debug', opts.runId || defaultRunId());
  let dirReady = false;

  /** Lazily create the artifact dir only when something is actually written. */
  function ensureDir() {
    if (!dirReady) {
      mkdirSync(dir, { recursive: true });
      dirReady = true;
    }
    return dir;
  }

  /** Resolve an artifact path, creating the dir on demand. */
  function artifact(name, ext) {
    return join(ensureDir(), `${slug(name)}.${ext}`);
  }

  return {
    /** Absolute path to this run's debug artifact directory. */
    get dir() {
      return dir;
    },

    /**
     * Save a screenshot. Never throws (a debug aid must not break a run).
     *
     * @param {string} [name='screenshot']
     * @param {object} [o] - { fullPage }
     * @returns {Promise<string|null>} path written, or null on failure
     */
    async screenshot(name = 'screenshot', o = {}) {
      const { fullPage = true } = o;
      const path = artifact(name, 'png');
      try {
        await page.screenshot({ path, fullPage });
        log.info(`screenshot → ${path}`);
        return path;
      } catch (err) {
        log.warn(`screenshot failed: ${err.message}`);
        return null;
      }
    },

    /**
     * Save the page's current HTML. Never throws.
     *
     * @param {string} [name='page']
     * @returns {Promise<string|null>} path written, or null on failure
     */
    async html(name = 'page') {
      const path = artifact(name, 'html');
      try {
        writeFileSync(path, await page.content());
        log.info(`html → ${path}`);
        return path;
      } catch (err) {
        log.warn(`html failed: ${err.message}`);
        return null;
      }
    },

    /**
     * Capture a full snapshot — URL, title, visible text, screenshot, and HTML —
     * to the debug dir, and log a concise summary. The go-to "what does this page
     * look like right now?" tool and the basis of failure auto-capture.
     *
     * @param {string} [name='dump']
     * @returns {Promise<object>} { dir, url, title, files, textPreview }
     */
    async dump(name = 'dump') {
      ensureDir();
      const url = safeCall(() => page.url(), '(unknown url)');
      const title = await safeAsync(() => page.title(), '(unknown title)');
      const text = (await safeAsync(() => page.evaluate(() => document.body?.innerText || ''), '')).trim();
      const textPath = artifact(`${name}-text`, 'txt');
      writeFileSync(textPath, `URL: ${url}\nTITLE: ${title}\n\n${text}`);
      const shot = await this.screenshot(`${name}-screenshot`);
      const htmlPath = await this.html(`${name}-page`);
      log.info(`dump "${name}": ${url} — ${title}`);
      log.info(`  text(${text.length}c) → ${textPath}`);
      return {
        dir,
        url,
        title,
        files: { text: textPath, screenshot: shot, html: htmlPath },
        textPreview: truncate(text, 500),
      };
    },

    /**
     * Describe what a selector matches: how many, and for the first few, their
     * tag/role/text/visibility/box. The fastest way to learn whether a selector
     * is right and what it actually targets.
     *
     * @param {string} selector - A CSS selector.
     * @param {object} [o] - { limit }
     * @returns {Promise<{count:number, elements:object[]}>}
     */
    async describe(selector, o = {}) {
      const { limit = 5 } = o;
      const data = await safeAsync(
        () => page.$$eval(selector, (els, lim) => els.slice(0, lim).map((el) => ({
          tag: el.tagName,
          role: el.getAttribute('role'),
          id: el.id || null,
          classes: (el.className || '').toString().slice(0, 80),
          text: (el.textContent || '').trim().slice(0, 80),
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          href: el.getAttribute('href'),
        })), limit),
        []
      );
      const count = await safeAsync(() => page.$$eval(selector, (els) => els.length), 0);
      log.info(`describe "${selector}": ${count} match(es)`);
      for (const el of data) log.info(`  ${formatElement(el)}`);
      return { count, elements: data };
    },

    /**
     * List interactive/clickable elements on the page (anchors, buttons, role
     * buttons/tabs/links, elements with cursor:pointer). Invaluable when the
     * obvious selector (e.g. an `<a href>`) doesn't exist and the real control is
     * a click-handled div.
     *
     * @param {object} [o] - { limit }
     * @returns {Promise<object[]>}
     */
    async clickables(o = {}) {
      const { limit = 40 } = o;
      const els = await safeAsync(
        () => page.evaluate((lim) => {
          const sel = 'a, button, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [onclick]';
          const out = [];
          for (const el of document.querySelectorAll(sel)) {
            const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            if (!visible) continue;
            const text = (el.textContent || '').trim();
            out.push({
              tag: el.tagName,
              role: el.getAttribute('role'),
              href: el.getAttribute('href'),
              text: text.slice(0, 60),
            });
            if (out.length >= lim) break;
          }
          return out;
        }, limit),
        []
      );
      log.info(`clickables: ${els.length} visible interactive element(s)`);
      for (const el of els) log.info(`  ${formatElement(el)}`);
      return els;
    },

    /**
     * Find where some text lives. Returns, for each text match, the leaf element
     * and its clickable ancestor (the thing you probably want to click). Solves
     * "I can see the text but what do I target?".
     *
     * @param {string|RegExp} pattern
     * @param {object} [o] - { limit }
     * @returns {Promise<object[]>}
     */
    async findText(pattern, o = {}) {
      const { limit = 10 } = o;
      const { source, flags } = regexParts(pattern);
      const hits = await safeAsync(
        () => page.evaluate((args) => {
          const re = new RegExp(args.source, args.flags);
          const clickableSel = 'a,button,[role="button"],[role="tab"],[role="link"],[onclick]';
          const isClickable = (el) =>
            el.matches(clickableSel) || getComputedStyle(el).cursor === 'pointer';
          // Match the element that DIRECTLY owns the text (in its own text nodes),
          // not childless leaves only — text can sit on an element that also has
          // element children (e.g. a tab label beside an icon). Matching own-text
          // also avoids reporting every ancestor up the tree for one string.
          const ownText = (el) =>
            [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
          while (walker.nextNode()) {
            const el = walker.currentNode;
            if (re.test(ownText(el))) {
              let anc = el, depth = 0;
              while (anc && depth < 8 && !isClickable(anc)) { anc = anc.parentElement; depth += 1; }
              out.push({
                text: (el.textContent || '').trim().slice(0, 60),
                leafTag: el.tagName,
                clickableAncestor: anc
                  ? { tag: anc.tagName, role: anc.getAttribute('role'), classes: (anc.className || '').toString().slice(0, 60) }
                  : null,
              });
              if (out.length >= args.limit) break;
            }
          }
          return out;
        }, { source, flags, limit }),
        []
      );
      log.info(`findText ${pattern}: ${hits.length} match(es)`);
      for (const h of hits) {
        const anc = h.clickableAncestor ? ` → clickable<${h.clickableAncestor.tag}${h.clickableAncestor.role ? ` role=${h.clickableAncestor.role}` : ''}>` : ' (no clickable ancestor)';
        log.info(`  "${h.text}" [${h.leafTag}]${anc}`);
      }
      return hits;
    },

    /**
     * Sample a page metric repeatedly over time and log how it evolves. Built to
     * answer "WHEN is this actually ready?" — the question that exposes why
     * `networkidle` lies and where a real readiness signal lives.
     *
     * @param {() => any} fn - Runs in the BROWSER; returns a JSON-serializable metric.
     *   e.g. `() => document.body.innerText.length`
     * @param {object} [o] - { samples=10, intervalMs=500, label='metric' }
     * @returns {Promise<Array<{t:number, value:any}>>}
     */
    async watch(fn, o = {}) {
      const { samples = 10, intervalMs = 500, label = 'metric' } = o;
      const series = [];
      for (let i = 0; i < samples; i++) {
        const value = await safeAsync(() => page.evaluate(fn), null);
        const t = i * intervalMs;
        series.push({ t, value });
        log.info(`watch[${label}] +${t}ms: ${formatValue(value)}`);
        if (i < samples - 1) await page.waitForTimeout(intervalMs);
      }
      return series;
    },

    /**
     * Quick count of elements matching a selector.
     *
     * @param {string} selector
     * @returns {Promise<number>}
     */
    async count(selector) {
      const n = await safeAsync(() => page.$$eval(selector, (els) => els.length), 0);
      log.info(`count "${selector}": ${n}`);
      return n;
    },
  };
}

// --- Pure helpers (no page I/O; unit-tested) -------------------------------

/**
 * Filesystem-safe slug for artifact filenames.
 *
 * @param {string} name
 * @returns {string}
 */
export function slug(name) {
  return String(name)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'debug';
}

/**
 * Truncate a string, appending an ellipsis + original length when cut.
 *
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  const str = String(s ?? '');
  if (str.length <= max) return str;
  return `${str.slice(0, max)}… (${str.length} chars total)`;
}

/**
 * Format a single element-summary object into a one-line string.
 *
 * @param {object} el - { tag, role, id, classes, text, visible, href }
 * @returns {string}
 */
export function formatElement(el) {
  const parts = [String(el.tag || '?').toLowerCase()];
  if (el.role) parts.push(`role=${el.role}`);
  if (el.id) parts.push(`#${el.id}`);
  if (el.href) parts.push(`href=${truncate(el.href, 40)}`);
  if (el.visible === false) parts.push('(hidden)');
  const tag = parts.join(' ');
  return el.text ? `${tag} — "${truncate(el.text, 60)}"` : tag;
}

/**
 * Format a watch() sample value compactly for logging.
 *
 * @param {any} v
 * @returns {string}
 */
export function formatValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return truncate(JSON.stringify(v), 120);
  return String(v);
}

/**
 * Decompose a string|RegExp pattern into source + flags for cross-context
 * (browser) reconstruction.
 *
 * @param {string|RegExp} pattern
 * @returns {{source:string, flags:string}}
 */
export function regexParts(pattern) {
  if (pattern instanceof RegExp) return { source: pattern.source, flags: pattern.flags };
  return { source: escapeRegExp(String(pattern)), flags: 'i' };
}

/**
 * Escape a string for literal use inside a RegExp.
 *
 * @param {string} s
 * @returns {string}
 */
export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A short, sortable-ish run id derived from high-res time (no Date dependency at
 * module load; called only when a debug dir is actually needed).
 *
 * @returns {string}
 */
function defaultRunId() {
  return `run-${process.pid}-${Math.floor(performance.now())}`;
}

/** Run a sync fn, returning a fallback if it throws. */
function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Await an async fn, returning a fallback if it throws. */
async function safeAsync(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
