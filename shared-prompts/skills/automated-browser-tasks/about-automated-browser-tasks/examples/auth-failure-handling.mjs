/**
 * auth-failure-handling
 *
 * Demonstrates the auth-failure contract. Scripts do NOT log in and do NOT
 * recover mid-run: they call `ctx.checkAuth()` after navigation and let the
 * harness convert a login-page redirect into a structured auth error. The agent
 * relays the message, the user logs in, and the SAME command is re-run.
 *
 * This script targets a page that requires authentication and simply reports
 * whether it reached real content — illustrating where checkAuth belongs.
 */

export const meta = {
  name: 'auth-failure-handling',
  description: 'Visit an authenticated page and confirm we are logged in (auth-pattern demo).',
  params: {
    url: {
      required: true,
      description:
        'Absolute URL of a page that requires authentication. If the Chrome ' +
        'session is expired, the harness will surface an actionable auth error.',
      validate: /^https?:\/\/.+/,
      invalidMessage: 'url must be an absolute http(s) URL.',
    },
    readySelector: {
      required: true,
      description:
        'CSS selector for an element that only appears once the authenticated ' +
        'content has loaded (e.g. a user avatar or app shell). Used to confirm we ' +
        'are past any login wall.',
    },
  },
};

/**
 * Entry point. Navigates, checks auth, then confirms authed content rendered.
 *
 * @param {object} ctx - The harness context.
 * @returns {Promise<object>} `{ found, url, message }`.
 */
export async function execute(ctx) {
  const { page, params } = ctx;
  const { url, readySelector } = params;

  await openAuthedPage(ctx, url, readySelector);

  return {
    found: true,
    url: page.url(),
    message: 'Reached authenticated content successfully.',
  };
}

/**
 * Navigate to an authenticated page and confirm we reached it — the canonical
 * auth-handling pattern. Many SPAs resolve auth client-side a beat AFTER load and
 * redirect to a login page, so we do NOT check the URL immediately. Instead we
 * wait for the success signal (`readySelector`, an element that only renders for
 * authenticated users). Only if that wait times out do we call `checkAuth()`: by
 * then the URL has settled, so a login page becomes a clear AuthError (which the
 * harness reports as `{ error: 'auth', message }`), while anything else re-throws
 * as a genuine render timeout. The script never tries to log in itself.
 *
 * @param {object} ctx - The harness context.
 * @param {string} url - The authenticated URL to load.
 * @param {string} readySelector - Element proving authed content rendered.
 * @returns {Promise<void>}
 */
async function openAuthedPage(ctx, url, readySelector) {
  const { page, logger, timeout, checkAuth } = ctx;
  const log = logger.child('navigate');
  log.info(`Loading authenticated page ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  try {
    await page.locator(readySelector).first().waitFor({ state: 'visible', timeout });
    log.info('Authenticated content is present');
  } catch (renderTimeout) {
    await checkAuth(); // throws AuthError if the settled URL is a login page
    throw renderTimeout;
  }
}
