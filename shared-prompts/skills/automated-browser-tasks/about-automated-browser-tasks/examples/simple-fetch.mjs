/**
 * simple-fetch
 *
 * The minimal shape of an automation script: navigate to one page, confirm we
 * are authenticated, and extract a piece of text. Use this as the starting
 * template for single-page data extraction.
 */

export const meta = {
  name: 'simple-fetch',
  description: 'Navigate to a single page and extract its <h1> (demonstration script).',
  params: {
    url: {
      required: true,
      description:
        'The absolute URL to load. Must include the scheme (https://). The page ' +
        'is loaded as the authenticated user via injected Chrome cookies.',
      validate: /^https?:\/\/.+/,
      invalidMessage: 'url must be an absolute http(s) URL, e.g. "https://example.com".',
    },
    selector: {
      required: false,
      default: 'h1',
      description:
        'CSS selector for the element whose text to extract. Defaults to the ' +
        'first <h1>. The longest matching element\'s text is returned.',
    },
    outputFile: {
      required: false,
      description:
        'Optional absolute path. When set, the runner writes the extracted text ' +
        'here instead of printing the result object.',
      validate: /^\//,
      invalidMessage: 'outputFile must be an absolute path (starting with "/").',
    },
  },
};

/**
 * Entry point. Loads the page, verifies auth, and extracts the target text.
 *
 * @param {object} ctx - The harness context.
 * @returns {Promise<object>} `{ found, url, content, outputFile }`.
 */
export async function execute(ctx) {
  const { page, params } = ctx;
  const { url, selector, outputFile } = params;

  await loadPage(ctx, url, selector);
  const content = await extractText(ctx, selector);

  return { found: content !== null, url: page.url(), content, outputFile };
}

/**
 * Load a URL and wait for the target element to render. Uses `domcontentloaded`
 * (NOT `networkidle`, which is not a readiness signal) and then waits for the
 * specific thing we need — the target selector. If that times out, we check auth:
 * a login redirect (resolved late by many apps) surfaces as a clear AuthError,
 * otherwise the render timeout is re-thrown.
 *
 * @param {object} ctx - The harness context.
 * @param {string} url - Absolute URL to load.
 * @param {string} selector - The element we expect to render (our success signal).
 * @returns {Promise<void>}
 */
async function loadPage(ctx, url, selector) {
  const { page, logger, timeout, checkAuth } = ctx;
  const log = logger.child('navigate');
  log.info(`Loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  } catch (renderTimeout) {
    await checkAuth(); // throws AuthError if the settled URL is a login page
    throw renderTimeout;
  }
}

/**
 * Extract the longest text matching a selector.
 *
 * @param {object} ctx - The harness context.
 * @param {string} selector - CSS selector to read.
 * @returns {Promise<string|null>} The text, or null if nothing matched.
 */
async function extractText(ctx, selector) {
  const { utils, logger } = ctx;
  const text = await utils.extractLongestText([selector], { minLength: 1 });
  logger.child('extract').info(text ? `Got ${text.length} chars` : 'No match');
  return text;
}
