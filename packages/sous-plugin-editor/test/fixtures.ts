/**
 * The files the coverage tests edit, and a way to write what an edit should make of them: the
 * fixture with a few exact replacements, so every other byte of the expected text is the
 * fixture's own.
 *
 * ```ts
 * change(JSONC, ['"mode": "loose"', '"mode": "strict"']);
 * ```
 */

/** A JSONC file with comments, inline and multi-line lists and objects. */
export const JSONC = `{
    // Settings for the demo.
    "name": "demo", // the name
    "mode": "loose",
    "list": ["b", "a", "b"],
    "people": [
        { "id": 1, "name": "ann", "tags": { "a": true } },
        { "id": 2, "name": "bob" },
        { "id": 1, "name": "ann again" }
    ],
    /* The options. */
    "options": { "x": 1, "nested": { "deep": true } },
    "count": 1,
    "flag": true,
    "empty": {},
    "notes": "hello",
    "scalar": "one",
    "single": ["only"]
}
`;

/** The same values as a YAML file with comments. */
export const YAML = `# Settings for the demo.
name: demo # the name
mode: loose
list:
  - b
  - a
  - b
people:
  - id: 1
    name: ann
    tags:
      a: true
  - id: 2
    name: bob
  - id: 1
    name: ann again
# The options.
options:
  x: 1
  nested:
    deep: true
count: 1
flag: true
empty: {}
notes: hello
scalar: one
single:
  - only
`;

/** A plain text file. */
export const TEXT = "# notes\nalpha\nbeta\n";

/**
 * The text with each `[from, to]` made, in turn. Each `from` must appear exactly once, so an
 * expected text never matches by accident.
 */
export function change(text: string, ...replacements: Array<[string, string]>): string {
    let result = text;

    for (const [from, to] of replacements) {
        const at = result.indexOf(from);

        if (at === -1 || result.indexOf(from, at + 1) !== -1) {
            throw new Error(`change(): ${JSON.stringify(from)} must appear exactly once.`);
        }

        result = result.slice(0, at) + to + result.slice(at + from.length);
    }

    return result;
}
