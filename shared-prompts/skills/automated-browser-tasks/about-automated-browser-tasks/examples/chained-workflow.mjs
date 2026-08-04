/**
 * chained-workflow
 *
 * Demonstrates composing scripts: one script invokes another via
 * `ctx.runChild`, reusing the same authenticated browser context. The child
 * runs in-process and returns its result object directly.
 *
 * Here the parent collects a list of item URLs from an index page, then runs a
 * child "fetch" script against each one. In a real project the child would be a
 * separate script file imported at the top; it is inlined here so the example
 * is self-contained.
 */

export const meta = {
  name: 'chained-workflow',
  description: 'Collect links from an index page, then fetch each via a child script.',
  params: {
    indexUrl: {
      required: true,
      description:
        'Absolute URL of the index/listing page to scrape links from. Loaded as ' +
        'the authenticated user.',
      validate: /^https?:\/\/.+/,
      invalidMessage: 'indexUrl must be an absolute http(s) URL.',
    },
    linkSelector: {
      required: false,
      default: 'a[href]',
      description:
        'CSS selector matching the links to follow on the index page. Defaults ' +
        'to all anchors with an href.',
    },
    limit: {
      required: false,
      default: 3,
      description:
        'Maximum number of links to follow, to keep runs bounded. Provided as a ' +
        'string on the CLI and coerced to a number.',
      validate: (v) => Number(v) > 0 || 'limit must be a positive number',
    },
  },
};

/** A small child script run once per collected link. Normally its own file. */
const fetchTitle = {
  meta: {
    name: 'fetch-title',
    params: {
      url: { required: true, validate: /^https?:\/\/.+/, invalidMessage: 'url must be absolute http(s)' },
    },
  },
  /**
   * Load a URL and return its document title.
   *
   * @param {object} ctx - The harness context (shares the parent's browser).
   * @returns {Promise<object>} `{ url, title }`.
   */
  async execute(ctx) {
    const { page, params, logger, timeout, checkAuth } = ctx;
    logger.child('navigate').info(`Fetching ${params.url}`);
    // domcontentloaded is enough here: the <title> is in the initial document.
    await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout });
    await checkAuth();
    return { url: page.url(), title: await page.title() };
  },
};

/**
 * Entry point. Collects links from the index, then fetches each via a child.
 *
 * @param {object} ctx - The harness context.
 * @returns {Promise<object>} `{ found, count, results }`.
 */
export async function execute(ctx) {
  const { params } = ctx;
  const { indexUrl, linkSelector, limit } = params;

  const links = await collectLinks(ctx, indexUrl, linkSelector, Number(limit));
  const results = await fetchEach(ctx, links);

  return { found: results.length > 0, count: results.length, results };
}

/**
 * Load the index page and collect up to `limit` link URLs.
 *
 * @param {object} ctx - The harness context.
 * @param {string} indexUrl - The listing page URL.
 * @param {string} selector - Selector matching links to follow.
 * @param {number} limit - Max links to return.
 * @returns {Promise<string[]>} Absolute link URLs.
 */
async function collectLinks(ctx, indexUrl, selector, limit) {
  const { page, logger, timeout, checkAuth } = ctx;
  const log = logger.child('collect');
  log.info(`Loading index ${indexUrl}`);
  await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout });
  // Success signal: the links we intend to read are present. If they never
  // appear, check auth (login redirects resolve late) before failing.
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout });
  } catch (renderTimeout) {
    await checkAuth();
    throw renderTimeout;
  }

  const hrefs = await page.$$eval(selector, (els) => els.map((el) => el.href));
  const unique = [...new Set(hrefs.filter(Boolean))].slice(0, limit);
  log.info(`Collected ${unique.length} link(s)`);
  return unique;
}

/**
 * Run the child fetch script against each link, in sequence.
 *
 * @param {object} ctx - The harness context.
 * @param {string[]} links - URLs to fetch.
 * @returns {Promise<object[]>} One child result per link.
 */
async function fetchEach(ctx, links) {
  const results = [];
  for (const url of links) {
    results.push(await ctx.runChild(fetchTitle, { url }));
  }
  return results;
}
