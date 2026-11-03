import { describe, expect, it } from "vitest";
import { Liquid } from "liquidjs";
import { regionsService } from "./helpers.js";
import type { LiquidRegions, RegionRender } from "../src/types.js";

/** Marks a source, renders the marked copy with a plain engine, and cuts the output apart. */
async function renderRegions(regions: LiquidRegions, source: string, vars: object = {}): Promise<RegionRender> {
    const marked = regions.mark(source);
    const rendered = await new Liquid().parseAndRender(marked.source, vars);

    return regions.split(rendered, marked);
}

describe("liquid.regions find()", () => {
    /** Outputs, single tags and blocks are each one section, with their source span. */
    it("should find each top-level section with its span, kind and head", async () => {
        const regions = await regionsService();
        const source = 'Hi {{ name }}!\n{% assign x = 1 %}{% if x == 1 %}one{% endif %}';

        const found = regions.find(source);

        expect(found.map((r) => [r.kind, r.label, r.head, source.slice(r.from, r.to)])).toEqual([
            ["output", "name", "{{ name }}", "{{ name }}"],
            ["tag", "assign", "{% assign x = 1 %}", "{% assign x = 1 %}"],
            ["block", "if", "{% if x == 1 %}", "{% if x == 1 %}one{% endif %}"],
        ]);
    });

    /** An if nested in a for belongs to the for, and its else is not one of the for's branches. */
    it("should count an if nested inside a for as part of one section", async () => {
        const regions = await regionsService();
        const source = "{% for i in list %}{% if i %}a{% else %}b{% endif %}{% endfor %}";

        const found = regions.find(source);

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ kind: "block", label: "for", from: 0, to: source.length, branches: ["body"] });
    });

    /** A branch starts after the whitespace a `-%}` trims. */
    it("should start a branch after the whitespace a -%} trims", async () => {
        const regions = await regionsService();
        const source = "{% if x -%}\n  yes{% else %}no{% endif %}";

        const [region] = regions.find(source);

        expect(region?.branches).toEqual(["{% if x -%}", "{% else %}"]);
        expect(region?.branchPoints?.[0]).toBe(source.indexOf("yes"));
        expect(region?.branchPoints?.[1]).toBe(source.indexOf("no"));
    });
});

describe("liquid.regions mark() and split()", () => {
    /** The else ran, so its count is 1 and the if's is 0, and the output is clean. */
    it("should report that the else branch of an if ran", async () => {
        const regions = await regionsService();

        const result = await renderRegions(regions, "A{% if x %}yes{% else %}no{% endif %}B", { x: false });

        expect(result.output).toBe("AnoB");
        expect(result.regions[0]).toMatchObject({ rendered: "no", ran: [0, 1], branches: ["{% if x %}", "{% else %}"] });
        expect(result.regions[0]).not.toHaveProperty("branchPoints");
        expect(result.segments).toEqual([{ start: 1, end: 3, region: 0 }]);
    });

    /** A loop's body count is its number of loops. */
    it("should count each run of a for loop's body", async () => {
        const regions = await regionsService();

        const result = await renderRegions(regions, "{% for i in list %}[{{ i }}]{% endfor %}", { list: [1, 2, 3] });

        expect(result.output).toBe("[1][2][3]");
        expect(result.regions[0]).toMatchObject({ rendered: "[1][2][3]", ran: [3] });
    });

    /** A for with an empty list runs its else. */
    it("should count a for loop's else when the list is empty", async () => {
        const regions = await regionsService();

        const result = await renderRegions(regions, "{% for i in list %}{{ i }}{% else %}none{% endfor %}", { list: [] });

        expect(result.regions[0]).toMatchObject({ rendered: "none", ran: [0, 1] });
    });

    /** The markers sit outside trimmed whitespace, so `{%-` and `-%}` trim exactly as without them. */
    it("should render {%- and -%} trimming the same as the unmarked source", async () => {
        const regions = await regionsService();
        const source = "a  \n  {%- if x -%}\n  yes\n  {%- endif -%}  \n  b {{- name -}} c";
        const vars = { x: true, name: "N" };

        const result = await renderRegions(regions, source, vars);

        expect(result.output).toBe(await new Liquid().parseAndRender(source, vars));
        expect(result.regions.map((r) => r.rendered)).toEqual(["yes", "N"]);
        expect(result.regions[0]?.ran).toEqual([1]);
    });

    /** Each segment maps a section's output back to where it sits in the whole output. */
    it("should give each section's place in the output", async () => {
        const regions = await regionsService();

        const result = await renderRegions(regions, "{{ a }}-{{ b }}", { a: "xx", b: "yyy" });

        expect(result.output).toBe("xx-yyy");
        expect(result.segments).toEqual([
            { start: 0, end: 2, region: 0 },
            { start: 3, end: 6, region: 1 },
        ]);
    });
});

describe("liquid.regions describeError()", () => {
    /** An if with no endif fails the marked render; the position is the if's, in the unmarked source. */
    it("should describe an unclosed tag plainly, at its place in the original source", async () => {
        const regions = await regionsService();
        const source = "{{ a }} hello\n  {% if x %}yes";
        const marked = regions.mark(source);

        const error = await new Liquid().parseAndRender(marked.source, {}).catch((e: unknown) => e);
        const problem = regions.describeError(error, source, marked);

        expect(problem).toEqual({ message: "This {% if %} has no matching {% endif %}.", pos: source.indexOf("{% if") });
    });

    /** An unclosed output stops find() itself; its error points at the {{. */
    it("should describe an unclosed output found while finding sections", async () => {
        const regions = await regionsService();
        const source = "ok\n{{ name";

        let error: unknown;
        try {
            regions.find(source);
        } catch (e) {
            error = e;
        }

        expect(regions.describeError(error, source)).toEqual({ message: "This {{ has no closing }}.", pos: 3 });
    });

    /** An error with no line and column has no position. */
    it("should give a null position when the error does not say where", async () => {
        const regions = await regionsService();

        expect(regions.describeError(new Error("boom"), "x")).toEqual({ message: "boom", pos: null });
    });
});

describe("liquid.regions uses() and warning()", () => {
    /** The variables read, less those the template sets itself. */
    it("should list the variables a template reads but does not set", async () => {
        const regions = await regionsService();

        expect(regions.uses("{% assign x = 1 %}{{ x }}{{ name }}{% for i in list %}{{ i }}{% endfor %}")).toEqual(["name", "list"]);
    });

    /** An unknown filter passes its input through, so it is warned about at its name. */
    it("should warn about a filter the engine does not have", async () => {
        const regions = await regionsService();
        const source = '{{ name | upcase }} {{ "a|b" | nosuch }}';

        expect(regions.warning(source)).toEqual({
            message: "There's no filter called nosuch, so it does nothing.",
            pos: source.indexOf("nosuch"),
        });
        expect(regions.warning("{{ name | upcase }}")).toBeUndefined();
    });

    /** A filter a plugin registers on the caller's engine counts as known. */
    it("should check filters against the engine the caller passes", async () => {
        const regions = await regionsService();
        const engine = new Liquid();

        engine.registerFilter("shout", (v: string) => `${v}!`);

        expect(regions.warning("{{ a | shout }}", { engine })).toBeUndefined();
    });
});
