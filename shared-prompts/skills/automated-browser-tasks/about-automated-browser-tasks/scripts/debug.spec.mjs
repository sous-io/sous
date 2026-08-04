import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createDebug,
  slug,
  truncate,
  formatElement,
  formatValue,
  regexParts,
  escapeRegExp,
} from './debug.mjs';

// --- Pure helpers ----------------------------------------------------------

describe('slug()', () => {
  it('replaces unsafe characters with dashes', () => {
    expect(slug('Foo Bar/baz!!')).toBe('Foo-Bar-baz');
  });
  it('trims leading/trailing dashes', () => {
    expect(slug('  !!hi!!  ')).toBe('hi');
  });
  it('falls back to "debug" for empty/blank input', () => {
    expect(slug('   ')).toBe('debug');
    expect(slug('')).toBe('debug');
  });
  it('caps length at 80 chars', () => {
    expect(slug('a'.repeat(200)).length).toBe(80);
  });
});

describe('truncate()', () => {
  it('returns the string unchanged when within max', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });
  it('cuts and annotates with total length when over max', () => {
    expect(truncate('abcdefghij', 5)).toBe('abcde… (10 chars total)');
  });
  it('handles null/undefined as empty', () => {
    expect(truncate(null, 5)).toBe('');
    expect(truncate(undefined, 5)).toBe('');
  });
});

describe('formatElement()', () => {
  it('formats tag, role, href, and text', () => {
    expect(formatElement({ tag: 'A', role: 'tab', href: '/x', text: 'Checks', visible: true }))
      .toBe('a role=tab href=/x — "Checks"');
  });
  it('marks hidden elements', () => {
    expect(formatElement({ tag: 'DIV', visible: false, text: '' })).toBe('div (hidden)');
  });
  it('omits text segment when there is no text', () => {
    expect(formatElement({ tag: 'BUTTON', visible: true })).toBe('button');
  });
});

describe('formatValue()', () => {
  it('stringifies objects compactly', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });
  it('passes through scalars', () => {
    expect(formatValue(42)).toBe('42');
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });
});

describe('regexParts() / escapeRegExp()', () => {
  it('decomposes a RegExp into source + flags', () => {
    expect(regexParts(/SUCCEEDED|FAILED/i)).toEqual({ source: 'SUCCEEDED|FAILED', flags: 'i' });
  });
  it('escapes a string pattern and defaults to case-insensitive', () => {
    expect(regexParts('a.b')).toEqual({ source: 'a\\.b', flags: 'i' });
  });
  it('escapeRegExp escapes regex metacharacters', () => {
    expect(escapeRegExp('a.b*c')).toBe('a\\.b\\*c');
  });
});

// --- Page-driven tools (fake page) -----------------------------------------

/** A logger that records messages instead of printing. */
function fakeLogger() {
  const messages = [];
  const mk = () => ({
    info: (m) => messages.push(`info:${m}`),
    warn: (m) => messages.push(`warn:${m}`),
    error: (m) => messages.push(`error:${m}`),
    child: () => mk(),
  });
  const l = mk();
  l.messages = messages;
  return l;
}

/** A configurable fake Playwright Page recording what the tools ask of it. */
function fakePage(overrides = {}) {
  const calls = { screenshot: [], evaluate: 0, waitForTimeout: [] };
  return {
    calls,
    url: () => overrides.url ?? 'https://example.com/page',
    title: async () => overrides.title ?? 'Example Title',
    content: async () => overrides.content ?? '<html><body>hi</body></html>',
    async screenshot(o) {
      calls.screenshot.push(o);
      if (overrides.screenshotThrows) throw new Error('boom');
      // emulate playwright writing the file
      const { writeFileSync } = await import('fs');
      writeFileSync(o.path, 'PNG');
    },
    async evaluate(fn, arg) {
      calls.evaluate += 1;
      if (typeof overrides.evaluate === 'function') return overrides.evaluate(fn, arg);
      return overrides.evaluateResult ?? null;
    },
    async $$eval(sel, fn, arg) {
      if (typeof overrides.$$eval === 'function') return overrides.$$eval(sel, fn, arg);
      return overrides.$$evalResult ?? [];
    },
    async waitForTimeout(ms) {
      calls.waitForTimeout.push(ms);
    },
  };
}

describe('createDebug() — artifacts', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'debug-spec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not create the dir until something is written', () => {
    const sub = join(dir, 'lazy');
    createDebug(fakePage(), fakeLogger(), { dir: sub });
    expect(existsSync(sub)).toBe(false);
  });

  it('screenshot writes a .png and returns its path', async () => {
    const debug = createDebug(fakePage(), fakeLogger(), { dir });
    const path = await debug.screenshot('shot one');
    expect(path).toBe(join(dir, 'shot-one.png'));
    expect(existsSync(path)).toBe(true);
  });

  it('screenshot returns null (never throws) on failure', async () => {
    const debug = createDebug(fakePage({ screenshotThrows: true }), fakeLogger(), { dir });
    expect(await debug.screenshot('x')).toBeNull();
  });

  it('html writes page content to a .html file', async () => {
    const debug = createDebug(fakePage({ content: '<p>real</p>' }), fakeLogger(), { dir });
    const path = await debug.html('snap');
    expect(readFileSync(path, 'utf8')).toBe('<p>real</p>');
  });

  it('dump captures url/title/text and writes a text artifact', async () => {
    const page = fakePage({ url: 'https://x/y', title: 'T', evaluateResult: 'BODY TEXT' });
    const debug = createDebug(page, fakeLogger(), { dir });
    const snap = await debug.dump('d');
    expect(snap.url).toBe('https://x/y');
    expect(snap.title).toBe('T');
    expect(snap.textPreview).toContain('BODY TEXT');
    expect(readFileSync(snap.files.text, 'utf8')).toContain('BODY TEXT');
    expect(existsSync(snap.files.screenshot)).toBe(true);
  });
});

describe('createDebug() — inspection tools', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'debug-spec-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('describe reports count and per-element summaries', async () => {
    const els = [{ tag: 'A', role: 'tab', text: 'Checks', visible: true }];
    const page = fakePage({
      $$eval: (_sel, _fn, arg) => (typeof arg === 'number' ? els : els.length),
    });
    const debug = createDebug(page, fakeLogger(), { dir });
    const out = await debug.describe('a', { limit: 5 });
    expect(out.count).toBe(1);
    expect(out.elements[0].text).toBe('Checks');
  });

  it('count returns the number of matches', async () => {
    const debug = createDebug(fakePage({ $$evalResult: 7 }), fakeLogger(), { dir });
    expect(await debug.count('div')).toBe(7);
  });

  it('clickables returns the evaluated list', async () => {
    const list = [{ tag: 'BUTTON', text: 'Go' }];
    const debug = createDebug(fakePage({ evaluateResult: list }), fakeLogger(), { dir });
    expect(await debug.clickables()).toEqual(list);
  });

  it('watch samples the metric N times and spaces them by interval', async () => {
    let n = 0;
    const page = fakePage({ evaluate: () => ++n });
    const debug = createDebug(page, fakeLogger(), { dir });
    const series = await debug.watch(() => 0, { samples: 3, intervalMs: 250, label: 'len' });
    expect(series.map((s) => s.value)).toEqual([1, 2, 3]);
    expect(series.map((s) => s.t)).toEqual([0, 250, 500]);
    // waits between samples only (N-1 times)
    expect(page.calls.waitForTimeout).toEqual([250, 250]);
  });

  it('tools degrade gracefully when the page throws', async () => {
    const page = fakePage({ evaluate: () => { throw new Error('nope'); }, $$eval: () => { throw new Error('nope'); } });
    const debug = createDebug(page, fakeLogger(), { dir });
    expect(await debug.count('x')).toBe(0);
    expect(await debug.clickables()).toEqual([]);
    expect((await debug.describe('x')).count).toBe(0);
  });

  it('findText passes the pattern source/flags through to the page', async () => {
    let received;
    const page = fakePage({ evaluate: (_fn, arg) => { received = arg; return []; } });
    const debug = createDebug(page, fakeLogger(), { dir });
    await debug.findText(/SUCCEEDED|FAILED/i, { limit: 3 });
    expect(received).toMatchObject({ source: 'SUCCEEDED|FAILED', flags: 'i', limit: 3 });
  });

  it('findText returns whatever the page evaluation yields', async () => {
    const hits = [{ text: 'Checks', leafTag: 'DIV', clickableAncestor: { tag: 'DIV', role: 'tab' } }];
    const debug = createDebug(fakePage({ evaluateResult: hits }), fakeLogger(), { dir });
    expect(await debug.findText('Checks')).toEqual(hits);
  });
});

/**
 * The own-text matching rule that findText runs in-browser, replicated here as a
 * pure check. This is the logic that the leaf-only version got wrong: an element
 * may own a matching text node AND have element children (e.g. a tab label beside
 * an icon). The in-browser behavior itself is covered by live tests.
 */
describe('findText own-text matching rule', () => {
  // Mirror of the in-browser predicate: match on an element's OWN text nodes.
  const ownText = (node) => (node.childNodes || [])
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent)
    .join('');
  const matches = (node, re) => re.test(ownText(node));

  it('matches an element whose own text node holds the pattern, even with element children', () => {
    // <div role=tab>"Checks"<span(icon)/></div>  — a common real-world tab shape.
    const tab = {
      childNodes: [
        { nodeType: 3, textContent: 'Checks' },
        { nodeType: 1, textContent: '' }, // icon element child
      ],
    };
    expect(matches(tab, /Checks/i)).toBe(true);
  });

  it('does NOT match an ancestor whose text comes only from descendants', () => {
    // A wrapper with no own text nodes — only an element child that contains text.
    const wrapper = { childNodes: [{ nodeType: 1, textContent: 'Checks' }] };
    expect(matches(wrapper, /Checks/i)).toBe(false);
  });

  it('matches a plain leaf', () => {
    const leaf = { childNodes: [{ nodeType: 3, textContent: 'SUCCEEDED' }] };
    expect(matches(leaf, /SUCCEEDED/)).toBe(true);
  });
});
