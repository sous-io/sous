import { describe, expect, it } from "vitest";
import { run } from "../test/helpers.js";
import { ALIASES, chainParams, OPERATIONS, operationInfo, OperationParamsError, resolveOperation } from "./operations.js";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const parse = (text: string | undefined) => JSON.parse(text ?? "null");

describe("resolveOperation()", () => {
    /**
     * Every shorthand and alias in spec 07's tables resolves to its core operation with the option
     * set, so the two entries below mean the same thing.
     *
     * resolveOperation("ensureFirst", { path: "a", item: "x" });
     * // -> ensureIncludes { path: "a", items: ["x"], position: "first" }
     */
    it("should resolve every shorthand and alias to its core operation with its option", () => {
        const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>]> = [
            ["ensureValue", { value: 1 }, "set", { value: 1 }],
            ["setIfMissing", { value: 1 }, "set", { value: 1, ifMissing: true }],
            ["ensureDefault", { value: 1 }, "set", { value: 1, ifMissing: true }],
            ["ensureAbsent", {}, "delete", {}],
            ["ensureKeys", { value: { a: 1 } }, "merge", { value: { a: 1 } }],
            ["ensureFirst", { item: "x" }, "ensureIncludes", { items: ["x"], position: "first" }],
            ["ensureLast", { item: "x" }, "ensureIncludes", { items: ["x"], position: "last" }],
            ["ensureAt", { item: "x", index: 2 }, "ensureIncludes", { items: ["x"], position: 2 }],
            ["prepend", { item: "x" }, "append", { items: ["x"], position: "first" }],
            ["insertAt", { item: "x", index: 2 }, "append", { items: ["x"], position: 2 }],
            ["ensureItemWhere", { match: { a: 1 }, item: { a: 1 } }, "upsertWhere", { match: { a: 1 }, item: { a: 1 } }],
            ["removeValues", { values: ["x"] }, "remove", { values: ["x"] }],
            ["ensureExcludes", { values: ["x"] }, "remove", { values: ["x"] }],
            ["removeWhere", { where: { a: 1 } }, "remove", { where: { a: 1 } }],
            ["ensureNoItemWhere", { where: { a: 1 } }, "remove", { where: { a: 1 } }],
            ["ensureUnique", {}, "dedupe", {}],
            ["ensureSorted", {}, "sort", {}],
        ];

        for (const [name, params, core, expected] of cases) {
            const resolved = resolveOperation(name, { path: "a", ...params });

            expect(resolved.definition.name, name).toBe(core);
            expect(resolved.params, name).toEqual({ path: "a", ...expected });
            expect(resolved.written).toBe(name);
        }
    });

    /**
     * An operation's key holds an object; there is no short form. Unknown names and parameters are
     * errors naming the operation.
     *
     * resolveOperation("set", "x");   // -> throws: 'set' must hold an object
     */
    it("should refuse a short form, an unknown operation and an unknown parameter", () => {
        expect(() => resolveOperation("set", "x")).toThrow(/must hold an object/);
        expect(() => resolveOperation("frobnicate", {})).toThrow(/no operation named/);
        expect(() => resolveOperation("set", { value: 1, colour: "red" })).toThrow(/no parameter 'colour'/);
        expect(() => resolveOperation("set", {})).toThrow(OperationParamsError);
        expect(() => resolveOperation("remove", { values: ["a"], where: { a: 1 } })).toThrow(/exactly one/);
    });

    /**
     * `path` left out, or `""`, is the root; `assertion: none` is read off the parameters.
     *
     * resolveOperation("sort", {});                                  // -> path ""
     * resolveOperation("sort", { path: "a", assertion: "none" });    // -> assertion false
     */
    it("should treat a missing or empty path as the root and read assertion: none", () => {
        expect(resolveOperation("sort", {}).path).toBe("");
        expect(resolveOperation("sort", { path: "" }).path).toBe("");
        expect(resolveOperation("sort", { path: "a", assertion: "none" }).assertion).toBe(false);
        expect(resolveOperation("sort", { path: "a" }).assertion).toBe(true);
    });
});

describe("operationInfo()", () => {
    /**
     * Every operation carries an order, and `sort` comes after the operations that add.
     *
     * operationInfo().find((op) => op.name === "sort").order > ensureIncludes's order
     */
    it("should give every operation an order with sort after the ones that add", () => {
        const order = (name: string) => operationInfo().find((info) => info.name === name)!.order;

        expect(order("sort")).toBeGreaterThan(order("ensureIncludes"));
        expect(order("sort")).toBeGreaterThan(order("append"));
        expect(order("sort")).toBeGreaterThan(order("upsertWhere"));
        expect(order("sort")).toBeGreaterThan(order("dedupe"));
        expect(order("ensureFileExists")).toBeLessThan(order("set"));
        expect(operationInfo().find((info) => info.name === "set")!.aliases.map((a) => a.name)).toContain("setIfMissing");
    });
});

describe("chainParams()", () => {
    /**
     * Positional arguments map to the operation's main parameters in order; a trailing object is
     * its options.
     *
     * chainParams("ensureLine", ["x", { position: "start" }]);   // -> { line: "x", position: "start" }
     */
    it("should map positional arguments and a trailing options object", () => {
        expect(chainParams("ensureLine", ["x", { position: "start" }])).toEqual({ line: "x", position: "start" });
        expect(chainParams("upsertWhere", [{ a: 1 }, { a: 1, b: 2 }])).toEqual({ match: { a: 1 }, item: { a: 1, b: 2 } });
        expect(chainParams("sort", [{ by: "id" }])).toEqual({ by: "id" });
        expect(chainParams("set", [{ value: 5 }])).toEqual({ value: { value: 5 } });
    });
});

describe("the core operations", () => {
    /**
     * `set` sets a value and records the old one; `down` restores it, or deletes a value that was
     * not there.
     *
     * {"env":{"A":"1"}}  set env.A "2"  -> {"env":{"A":"2"}}; undo -> {"env":{"A":"1"}}
     */
    it("should set a value and restore the recorded one on undo", () => {
        const done = run(json({ env: { A: "1" } }), "json", "set", { path: "env.A", value: "2" });

        expect(parse(done.text)).toEqual({ env: { A: "2" } });
        expect(done.record).toEqual({ changed: true, existed: true, previous: "1" });
        expect(parse(done.undo())).toEqual({ env: { A: "1" } });

        const fresh = run(json({}), "json", "set", { path: "env.B", value: true });

        expect(parse(fresh.undo())).toEqual({ env: {} });
    });

    /**
     * `set` with `ifMissing` leaves an existing value alone.
     *
     * {"a":1}  set a 2 ifMissing  -> {"a":1}
     */
    it("should leave an existing value alone with ifMissing", () => {
        const done = run(json({ a: 1 }), "json", "setIfMissing", { path: "a", value: 2 });

        expect(parse(done.text)).toEqual({ a: 1 });
        expect(done.record).toEqual({ changed: false });
    });

    /**
     * `delete` removes a value and records it; `down` puts it back.
     */
    it("should delete a value and put it back on undo", () => {
        const done = run(json({ a: 1, b: 2 }), "json", "delete", { path: "a" });

        expect(parse(done.text)).toEqual({ b: 2 });
        expect(parse(done.undo())).toEqual({ b: 2, a: 1 });
    });

    /**
     * `merge` combines an object key by key, adding a list's missing items once; `down` removes
     * what it added and restores what it changed. Running it twice adds nothing twice.
     *
     * {"p":{"allow":["a"]},"x":1}  merge {p:{allow:["a","b"]},x:2,y:3}
     * // -> {"p":{"allow":["a","b"]},"x":2,"y":3}
     */
    it("should merge deeply, add only missing list items, and undo exactly", () => {
        const done = run(json({ p: { allow: ["a"] }, x: 1 }), "json", "merge", { value: { p: { allow: ["a", "b"] }, x: 2, y: 3 } });

        expect(parse(done.text)).toEqual({ p: { allow: ["a", "b"] }, x: 2, y: 3 });
        expect(parse(done.undo())).toEqual({ p: { allow: ["a"] }, x: 1 });

        const twice = run(done.text, "json", "merge", { value: { p: { allow: ["a", "b"] } } });

        expect(parse(twice.text)).toEqual({ p: { allow: ["a", "b"] }, x: 2, y: 3 });
    });

    /**
     * `ensureIncludes` adds only the missing items, at the end; `down` removes only those.
     *
     * ["a"]  ensureIncludes ["a","b"]  -> ["a","b"]; someone adds "c"; undo -> ["a","c"]
     */
    it("should add only missing items and remove only those on undo", () => {
        const done = run(json({ l: ["a"] }), "json", "ensureIncludes", { path: "l", items: ["a", "b"] });

        expect(parse(done.text)).toEqual({ l: ["a", "b"] });
        expect(done.record).toEqual({ added: ["b"], moved: [] });

        done.session.document().atPath("l").append("c");

        expect(parse(done.undo())).toEqual({ l: ["a", "c"] });
    });

    /**
     * `ensureIncludes` with a position makes the items be there: first, last or at an index,
     * moving an item that is elsewhere.
     *
     * ["a","x","b"]  ensureFirst "x"  -> ["x","a","b"]
     * ["a","x","b"]  ensureLast "x"   -> ["a","b","x"]
     * ["a","b","c"]  ensureAt 1 "z"   -> ["a","z","b","c"]
     */
    it("should place items first, last or at an index, moving them when needed", () => {
        expect(parse(run(json(["a", "x", "b"]), "json", "ensureFirst", { item: "x" }).text)).toEqual(["x", "a", "b"]);
        expect(parse(run(json(["a", "x", "b"]), "json", "ensureLast", { item: "x" }).text)).toEqual(["a", "b", "x"]);
        expect(parse(run(json(["a", "b", "c"]), "json", "ensureAt", { item: "z", index: 1 }).text)).toEqual(["a", "z", "b", "c"]);
        expect(parse(run(json(["x", "a"]), "json", "ensureFirst", { item: "x" }).text)).toEqual(["x", "a"]);

        const moved = run(json(["a", "x", "b"]), "json", "ensureFirst", { item: "x" });

        expect(parse(moved.undo())).toEqual(["a", "x", "b"]);
    });

    /**
     * `append` always adds, even an item already there; `prepend` adds first.
     *
     * ["a"]  append "a"  -> ["a","a"]
     */
    it("should always add with append and prepend", () => {
        expect(parse(run(json(["a"]), "json", "append", { item: "a" }).text)).toEqual(["a", "a"]);
        expect(parse(run(json(["a"]), "json", "prepend", { item: "b" }).text)).toEqual(["b", "a"]);
        expect(parse(run(json(["a", "b"]), "json", "insertAt", { item: "z", index: 1 }).text)).toEqual(["a", "z", "b"]);

        const done = run(json(["a"]), "json", "append", { item: "a" });

        expect(parse(done.undo())).toEqual(["a"]);
    });

    /**
     * `upsertWhere` replaces the item matching `match`, or adds it; `down` restores or removes it.
     */
    it("should upsert by matching fields and undo the replacement or the addition", () => {
        const repos = { repos: [{ repo: "x", rev: "1" }] };
        const replaced = run(json(repos), "json", "upsertWhere", { path: "repos", match: { repo: "x" }, item: { repo: "x", rev: "2" } });

        expect(parse(replaced.text)).toEqual({ repos: [{ repo: "x", rev: "2" }] });
        expect(parse(replaced.undo())).toEqual(repos);

        const added = run(json(repos), "json", "upsertWhere", { path: "repos", match: { repo: "y" }, item: { repo: "y" } });

        expect(parse(added.text).repos).toHaveLength(2);
        expect(parse(added.undo())).toEqual(repos);
    });

    /**
     * `remove` takes away items equal to `values` or matching `where`; `down` puts them back where
     * they were.
     */
    it("should remove by values or where and reinsert on undo", () => {
        const byValue = run(json(["a", "b", "a", "c"]), "json", "removeValues", { values: ["a"] });

        expect(parse(byValue.text)).toEqual(["b", "c"]);
        expect(parse(byValue.undo())).toEqual(["a", "b", "a", "c"]);

        const byWhere = run(json([{ k: 1 }, { k: 2 }]), "json", "removeWhere", { where: { k: 1 } });

        expect(parse(byWhere.text)).toEqual([{ k: 2 }]);
    });

    /**
     * `dedupe` keeps the first of each item; `sort` orders a list; `sortKeys` orders an object's
     * keys; at the root when there is no path.
     *
     * ["b","a","b"]  dedupe then sort  -> ["a","b"]
     */
    it("should dedupe, sort and sort keys, at the root when there is no path", () => {
        expect(parse(run(json(["b", "a", "b"]), "json", "dedupe", {}).text)).toEqual(["b", "a"]);
        expect(parse(run(json(["b", "c", "a"]), "json", "sort", {}).text)).toEqual(["a", "b", "c"]);
        expect(parse(run(json([{ n: 2 }, { n: 1 }]), "json", "sortBy", { by: "n" }).text)).toEqual([{ n: 1 }, { n: 2 }]);
        expect(parse(run(json([1, 3, 2]), "json", "sort", { descending: true }).text)).toEqual([3, 2, 1]);
        expect(Object.keys(parse(run(json({ b: 1, a: 2 }), "json", "sortKeys", {}).text))).toEqual(["a", "b"]);
    });

    /**
     * Comments and layout of a JSONC file survive an edit.
     */
    it("should keep comments in a JSONC file", () => {
        const text = '{\n    // keep me\n    "allow": ["a"]\n}\n';
        const done = run(text, "jsonc", "ensureIncludes", { path: "allow", items: ["b"] });

        expect(done.text).toContain("// keep me");
        expect(done.text).toContain('"b"');
    });

    /**
     * An operation that cannot be made (a list operation on a string) throws EditNotPossible,
     * which the editor turns into a warning.
     */
    it("should throw EditNotPossible for a list operation on a value that is not a list", () => {
        expect(() => run(json({ a: "x" }), "json", "ensureIncludes", { path: "a", items: ["b"] })).toThrow(/needs a list/);
    });
});

describe("lines and blocks", () => {
    /**
     * `ensureLine` on a plain text file adds the line when it is missing, at `position`; a line
     * already anywhere in the file is left; `down` removes it only if Sous added it.
     *
     * "node_modules/\n"  ensureLine "x" after "# s" (missing)  -> "node_modules/\nx\n"
     */
    it("should ensure a line at each position and undo only an added line", () => {
        const text = "# s\nnode_modules/\n";

        expect(run(text, "text", "ensureLine", { line: "x" }).text).toBe("# s\nnode_modules/\nx\n");
        expect(run(text, "text", "ensureLine", { line: "x", position: "start" }).text).toBe("x\n# s\nnode_modules/\n");
        expect(run(text, "text", "ensureLine", { line: "x", position: { after: "# s" } }).text).toBe("# s\nx\nnode_modules/\n");
        expect(run(text, "text", "ensureLine", { line: "x", position: { before: "node_modules/" } }).text).toBe("# s\nx\nnode_modules/\n");
        expect(run(text, "text", "ensureLine", { line: "x", position: { line: 2 } }).text).toBe("# s\nx\nnode_modules/\n");
        expect(run(text, "text", "ensureLine", { line: "x", position: { after: "nope" } }).text).toBe("# s\nnode_modules/\nx\n");

        const present = run(text, "text", "ensureLine", { line: "node_modules/" });

        expect(present.text).toBe(text);
        expect(present.undo()).toBe(text);

        const added = run(text, "text", "ensureLine", { line: "x" });

        expect(added.undo()).toBe(text);
    });

    /**
     * A missing text file is created with just the line; undoing leaves nothing.
     */
    it("should create a missing text file with the line", () => {
        expect(run(undefined, "text", "ensureLine", { line: "x" }).text).toBe("x\n");
    });

    /**
     * `ensureBlock` keeps a block between marker lines in the file's comment style, replacing its
     * content when it differs; `down` removes a block it created.
     */
    it("should keep a managed block between markers and remove it on undo", () => {
        const done = run("a\n", "text", "ensureBlock", { name: "kw", content: "one\ntwo" }, "/x/.gitignore");

        expect(done.text).toBe(
            // A blank line separates a block added at the end from the line before it.
            "a\n\n# >>> sous managed: kw (do not edit between these markers)\none\ntwo\n# <<< sous managed: kw\n",
        );
        expect(done.undo()).toBe("a\n");

        const md = run("# T\n", "markdown", "ensureBlock", { name: "kw", content: "x" }, "/x/AGENTS.md");

        expect(md.text).toContain("<!-- >>> sous managed: kw (do not edit between these markers) -->");
    });

    /**
     * The frontmatter of a Markdown file is a YAML document; the body is kept byte for byte.
     */
    it("should edit a Markdown file's frontmatter and keep its body", () => {
        const text = "---\nname: review\nmodel: sonnet\n---\n# Body\n\ntext\n";
        const done = run(text, "markdown", "set", { path: "model", value: "opus" });

        expect(done.text).toBe("---\nname: review\nmodel: opus\n---\n# Body\n\ntext\n");
        expect(run("# Body\n", "markdown", "set", { path: "model", value: "opus" }).text).toBe("---\nmodel: opus\n---\n# Body\n");
    });
});

describe("the rest of the list", () => {
    /**
     * renameKey, deleteKeys, keepOnlyKeys, structure, numbers and text replacement each act and
     * undo.
     */
    it("should apply and undo the further operations", () => {
        const rename = run(json({ a: 1 }), "json", "renameKey", { path: "a", name: "b" });

        expect(parse(rename.text)).toEqual({ b: 1 });
        expect(parse(rename.undo())).toEqual({ a: 1 });

        const keys = run(json({ a: 1, b: 2, c: 3 }), "json", "deleteKeys", { keys: ["a", "c"] });

        expect(parse(keys.text)).toEqual({ b: 2 });
        expect(parse(keys.undo())).toEqual({ b: 2, a: 1, c: 3 });
        expect(parse(run(json({ a: 1, b: 2 }), "json", "keepOnlyKeys", { keys: ["a"] }).text)).toEqual({ a: 1 });
        expect(parse(run(json({ a: 1 }), "json", "wrapInList", { path: "a" }).text)).toEqual({ a: [1] });
        expect(parse(run(json({ a: [1] }), "json", "unwrapList", { path: "a" }).text)).toEqual({ a: 1 });
        expect(parse(run(json({ a: "x" }), "json", "ensureObject", { path: "a" }).text)).toEqual({ a: {} });
        expect(parse(run(json({ n: 1 }), "json", "increment", { path: "n", value: 2 }).text)).toEqual({ n: 3 });
        expect(parse(run(json({ n: 1 }), "json", "decrement", { path: "n" }).text)).toEqual({ n: 0 });
        expect(parse(run(json({ t: true }), "json", "toggle", { path: "t" }).text)).toEqual({ t: false });
        expect(run("a b a\n", "text", "replaceText", { match: "a", value: "z" }).text).toBe("z b z\n");
        expect(run("v1 v22\n", "text", "replacePattern", { match: "v(\\d+)", value: "w$1" }).text).toBe("w1 w22\n");
        expect(run("a\nb\na\n", "text", "removeLine", { line: "a" }).text).toBe("b\n");
        expect(run("a\n", "text", "appendText", { value: "b\n" }).text).toBe("a\nb\n");
        expect(parse(run(json({ l: [{ k: 1, v: 1 }] }), "json", "updateWhere", { path: "l", where: { k: 1 }, value: { v: 2 } }).text)).toEqual({
            l: [{ k: 1, v: 2 }],
        });
        expect(parse(run(json({ a: 1 }), "json", "deleteIfEquals", { path: "a", value: 1 }).text)).toEqual({});
        expect(parse(run(json({ a: {} }), "json", "deleteIfEmpty", { path: "a" }).text)).toEqual({});
        expect(parse(run(json({ a: 1 }), "json", "setIfEquals", { path: "a", value: 2, equals: 1 }).text)).toEqual({ a: 2 });
    });

    /**
     * Every alias names an operation that exists.
     */
    it("should have every alias point at a defined operation", () => {
        for (const entry of ALIASES.values()) {
            expect(OPERATIONS.has(entry.target), entry.name).toBe(true);
        }
    });
});

describe("the operations the document library made cheap", () => {
    /**
     * moveKeyBefore, moveKeyAfter, moveKeyFirst and moveKeyLast move one key of an object and keep
     * its text; a missing key or anchor changes nothing.
     *
     * moveKeyFirst { key: "model" } on { name, model } -> { model, name }
     */
    it("should move a key before, after, first and last, keeping the rest of the text", () => {
        const text = '{\n  "name": "x",\n  "model": "y",\n  "tools": []\n}\n';
        const keysAfter = (operation: string, params: Record<string, string>) => Object.keys(parse(run(text, "jsonc", operation, params).text));

        expect(keysAfter("moveKeyFirst", { key: "model" })).toEqual(["model", "name", "tools"]);
        expect(keysAfter("moveKeyLast", { key: "name" })).toEqual(["model", "tools", "name"]);
        expect(keysAfter("moveKeyBefore", { key: "tools", anchor: "name" })).toEqual(["tools", "name", "model"]);
        expect(keysAfter("moveKeyAfter", { key: "name", anchor: "tools" })).toEqual(["model", "tools", "name"]);
        expect(run(text, "jsonc", "moveKeyFirst", { key: "missing" }).text).toBe(text);
        expect(run(text, "jsonc", "moveKeyBefore", { key: "name", anchor: "missing" }).text).toBe(text);
        expect(run("name: x\nmodel: y\n", "yaml", "moveKeyFirst", { key: "model" }).text).toBe("model: y\nname: x\n");
    });

    /**
     * prependIfMissing puts the missing items first, in the order given, leaves an item already
     * there where it is, and its undo removes only what it added.
     *
     * prependIfMissing { items: ["a", "b"] } on ["c", "b"] -> ["a", "c", "b"]
     */
    it("should put missing items first, and undo only those", () => {
        const done = run(json({ l: ["c", "b"] }), "json", "prependIfMissing", { path: "l", items: ["a", "b"] });

        expect(parse(done.text)).toEqual({ l: ["a", "c", "b"] });
        expect(parse(done.undo())).toEqual({ l: ["c", "b"] });
        expect(parse(run(json({}), "json", "prependIfMissing", { path: "l", items: ["x", "y"] }).text)).toEqual({ l: ["x", "y"] });
    });

    /**
     * A plain text file keeps every line it does not touch, its line endings included, and a
     * damaged managed block is skipped, never guessed at.
     *
     * ensureLine "dist/" on "a\r\nb" -> "a\r\nb\r\ndist/"
     */
    it("should keep each untouched line's ending, and skip a damaged block", () => {
        expect(run("a\r\nb", "text", "ensureLine", { line: "dist/" }).text).toBe("a\r\nb\r\ndist/");
        expect(run("a\r\nb\n", "text", "ensureLine", { line: "x", position: { after: "a" } }).text).toBe("a\r\nx\r\nb\n");
        expect(() =>
            run("# >>> sous managed: kw (do not edit between these markers)\nx\n", "text", "ensureBlock", { name: "kw", content: "y" }, "/x/.gitignore"),
        ).toThrow(/damaged/);
    });
});
