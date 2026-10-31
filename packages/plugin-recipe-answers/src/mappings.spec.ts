import type { ServiceContext } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { MemoryConfd, names, serviceReader, variable } from "../test/stand-ins.js";
import { formatMappingTarget, mappedNamesFor, mappingMatches, MappingsService, mappingTargetFor, parseMappingTarget, VAR_MAPPINGS_FILE } from "./mappings.js";

describe("parseMappingTarget()", () => {
    /**
     * parseMappingTarget should return the parts of a repository-qualified target.
     *
     * parseMappingTarget("sous-recipes:misc/stuff/apiUrl");
     * // -> { repo: "sous-recipes", namespace: "misc", recipe: "stuff", variable: "apiUrl" }
     */
    it("should parse a repository-qualified target", () => {
        expect(parseMappingTarget("sous-recipes:misc/stuff/apiUrl")).toEqual({ repo: "sous-recipes", namespace: "misc", recipe: "stuff", variable: "apiUrl" });
    });

    /** parseMappingTarget should accept a target with no repository, which matches in any one. */
    it("should parse a target with no repository qualifier", () => {
        expect(parseMappingTarget("misc/stuff/apiUrl")).toEqual({ namespace: "misc", recipe: "stuff", variable: "apiUrl" });
    });

    /** parseMappingTarget should refuse a target missing a part, quoting it and showing the form. */
    it("should refuse a target that is missing a segment", () => {
        expect(() => parseMappingTarget("misc/apiUrl")).toThrow(/namespace, a recipe and a variable/);
    });

    /** parseMappingTarget should refuse uppercase names and a variable that is not camelCase. */
    it("should refuse uppercase names and a bad variable name", () => {
        expect(() => parseMappingTarget("Misc/stuff/apiUrl")).toThrow(/must be lowercase/);
        expect(() => parseMappingTarget("misc/stuff/API_URL")).toThrow(/must be camelCase/);
        expect(() => parseMappingTarget("  ")).toThrow(/must not be empty/);
    });

    /** formatMappingTarget should round-trip with parseMappingTarget. */
    it("should round-trip through formatMappingTarget", () => {
        const written = "sous-recipes:misc/stuff/apiUrl";

        expect(formatMappingTarget(parseMappingTarget(written))).toBe(written);
        expect(formatMappingTarget(mappingTargetFor(variable()))).toBe(written);
    });
});

describe("mappingMatches() and mappedNamesFor()", () => {
    /** mappingMatches should say whether a target names this exact variable. */
    it("should match on namespace, recipe and variable", () => {
        expect(mappingMatches(parseMappingTarget("misc/stuff/apiUrl"), variable())).toBe(true);
        expect(mappingMatches(parseMappingTarget("misc/other/apiUrl"), variable())).toBe(false);
    });

    /** mappingMatches should refuse a target naming a different repository. */
    it("should respect the repository qualifier when there is one", () => {
        expect(mappingMatches(parseMappingTarget("elsewhere:misc/stuff/apiUrl"), variable())).toBe(false);
    });

    /**
     * mappedNamesFor should return every name bound to one variable, sorted.
     *
     * mappedNamesFor({ ZED: "misc/stuff/apiUrl", ABLE: "misc/stuff/apiUrl" }, apiUrl);
     * // -> ["ABLE", "ZED"]
     */
    it("should return every bound name in sorted order", () => {
        expect(mappedNamesFor({ ZED: "misc/stuff/apiUrl", ABLE: "misc/stuff/apiUrl", OTHER: "misc/stuff/other" }, variable())).toEqual(["ABLE", "ZED"]);
    });
});

describe("MappingsService", () => {
    /** A service over a stand-in managed file and a config holding the given records. */
    function service(records: Record<string, string> = {}) {
        const confd = new MemoryConfd();
        const ctx = {
            config: { get: (key: string) => (key === "varMappings" ? records : undefined) },
            services: serviceReader({ "confd.managed": confd, "variables.names": names }),
        } as unknown as ServiceContext;

        return { confd, mappings: new MappingsService(ctx) };
    }

    /** list should parse every record in the built config. */
    it("should list the records of the config", () => {
        expect(service({ TEAM_API: "misc/stuff/apiUrl" }).mappings.list()).toEqual({ TEAM_API: { namespace: "misc", recipe: "stuff", variable: "apiUrl" } });
    });

    /** set should write one record into conf.d/520, keeping the records already there. */
    it("should write one record surgically and keep the others", async () => {
        const { confd, mappings } = service();

        await mappings.set("ONE", parseMappingTarget("misc/stuff/apiUrl"));
        const result = await mappings.set("TWO", parseMappingTarget("sous-recipes:misc/stuff/other"));

        expect(result).toEqual({ file: `/project/.sous/conf.d/${VAR_MAPPINGS_FILE}`, changed: true });
        expect(confd.data[VAR_MAPPINGS_FILE]).toEqual({ varMappings: { ONE: "misc/stuff/apiUrl", TWO: "sous-recipes:misc/stuff/other" } });
    });

    /** set should write nothing on a dry run, and remove should delete one record. */
    it("should honor a dry run and remove a record", async () => {
        const { confd, mappings } = service();

        await mappings.set("ONE", parseMappingTarget("misc/stuff/apiUrl"), { dryRun: true });
        expect(confd.data[VAR_MAPPINGS_FILE]).toBeUndefined();

        await mappings.set("ONE", parseMappingTarget("misc/stuff/apiUrl"));
        expect((await mappings.remove("ONE")).changed).toBe(true);
        expect(confd.data[VAR_MAPPINGS_FILE]).toEqual({ varMappings: {} });
    });

    /** set should refuse a name that is not an environment variable name. */
    it("should refuse a bad environment name", async () => {
        await expect(service().mappings.set("not a name", parseMappingTarget("misc/stuff/apiUrl"))).rejects.toThrow(/not valid/);
    });
});
