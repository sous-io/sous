import { isSousErrorOfKind, type SousError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { resolveBlock } from "./resolve-block.js";

/** Resolves a block strictly and gives the scope. */
function resolve(block: Record<string, unknown>, inherited: Record<string, string> = {}): Record<string, string> {
    return resolveBlock(block, inherited, "_vars").scope;
}

/** The error a strict resolve throws, with its message and details joined. */
function failure(block: Record<string, unknown>, inherited: Record<string, string> = {}): { error: unknown; text: string } {
    try {
        resolve(block, inherited);
    } catch (error) {
        const sous = error as SousError;

        return { error, text: [sous.message, ...(sous.details ?? [])].join("\n") };
    }

    throw new Error("expected an error");
}

describe("resolveBlock()", () => {
    /** Block values win over inherited ones of the same name. */
    it("should let block vars override inherited vars with the same name", () => {
        const result = resolve({ key: "block" }, { key: "inherited", other: "x" });

        expect(result.key).toBe("block");
        expect(result.other).toBe("x");
    });

    /** A block value can use an inherited one. */
    it("should allow block vars to reference inherited vars", () => {
        const result = resolve({ full: "${base}/sub" }, { base: "/home/user" });

        expect(result.full).toBe("/home/user/sub");
        expect(result.base).toBe("/home/user");
    });

    /** A block value can use another in the same block. */
    it("should resolve intra-block variable dependencies", () => {
        const result = resolve({ root: "/data", file: "${root}/output.md" });

        expect(result.root).toBe("/data");
        expect(result.file).toBe("/data/output.md");
    });

    /** A chain a → b → c resolves in any order it is written. */
    it("should resolve a multi-hop chain declared in scrambled order", () => {
        expect(resolve({ a: "${b}/a", b: "${c}/b", c: "root" })).toEqual({ a: "root/b/a", b: "root/b", c: "root" });
        expect(resolve({ a: "${b}/a", c: "root", b: "${c}/b" })).toEqual({ a: "root/b/a", b: "root/b", c: "root" });
    });

    /** Declaration order does not matter. */
    it("should resolve an entry that references a later sibling", () => {
        expect(resolve({ file: "${root}/x", root: "/data" })).toEqual(resolve({ root: "/data", file: "${root}/x" }));
    });

    /** An empty block gives the inherited scope. */
    it("should return the inherited scope when the block is empty", () => {
        expect(resolve({}, { x: "1" })).toEqual({ x: "1" });
    });

    /** Nested levels chain: a target value sees a root value. */
    it("should thread inherited scope through nested blocks", () => {
        const root = resolve({ root: "/proj" });
        const compilation = resolve({ sub: "${root}/x" }, root);
        const target = resolve({ file: "${sub}/AGENTS.md" }, compilation);

        expect(target).toEqual({ root: "/proj", sub: "/proj/x", file: "/proj/x/AGENTS.md" });
    });

    /** Numbers and switches written in a block become strings. */
    it("should turn non-string values into strings", () => {
        expect(resolve({ port: 8080, on: true })).toEqual({ port: "8080", on: "true" });
    });

    /** A direct cycle is a ConfigError naming both members. */
    it("should throw a ConfigError on a direct cycle naming both members", () => {
        const { error, text } = failure({ a: "${b}", b: "${a}" });

        expect(isSousErrorOfKind(error, "config")).toBe(true);
        expect(text).toMatch(/cycle/i);
        expect(text).toMatch(/a -> b -> a|b -> a -> b/);
    });

    /** A self-cycle can never resolve. */
    it("should throw a ConfigError on a self-cycle", () => {
        const { error, text } = failure({ a: "${a}" });

        expect(isSousErrorOfKind(error, "config")).toBe(true);
        expect(text).toMatch(/a -> a/);
    });

    /** A name defined nowhere is named, with what is in scope. */
    it("should throw a ConfigError on an undefined reference, naming it and the in-scope vars", () => {
        const { error, text } = failure({ path: "${missing}/x" }, { present: "/p" });

        expect(isSousErrorOfKind(error, "config")).toBe(true);
        expect(text).toContain("missing");
        expect(text).toMatch(/undefined/i);
        expect(text).toContain("path");
        expect(text).toMatch(/in scope[\s\S]*present/i);
        expect(text).toContain("in _vars");
    });

    /** The resolvable entry is resolved before the error about a cycle beside it. */
    it("should finalize the resolvable entry before erroring on a co-resident cycle", () => {
        const { text } = failure({ good: "${base}/x", a: "${b}", b: "${a}" }, { base: "/root" });

        expect(text).toMatch(/a -> b -> a|b -> a -> b/);
        expect(text).toMatch(/in scope[\s\S]*good/i);
        expect(text).toMatch(/in scope[\s\S]*base/i);
    });

    /**
     * `projectRoot` (and every other auto-variable) is set by sous: setting it is an error.
     *
     * resolveBlock({ projectRoot: "${sousDir}/.." }, …)  // ConfigError: sous sets it
     */
    it("should refuse a block that sets an auto-variable", () => {
        const { error, text } = failure({ projectRoot: "${sousDir}/.." }, { sousDir: "/p/.sous" });

        expect(isSousErrorOfKind(error, "config")).toBe(true);
        expect(text).toContain('"projectRoot", which sous sets itself');
        expect(failure({ sousDir: "/x" }).text).toContain("sous sets itself");
    });

    /** With `partial`, entries that cannot resolve yet are left out, and auto-variable names ignored. */
    it("should leave out what cannot resolve yet when partial", () => {
        const result = resolveBlock({ a: "${later}", b: "ok", projectRoot: "/x" }, { projectRoot: "/p" }, "_vars", {
            partial: true,
        });

        expect(result.scope).toEqual({ projectRoot: "/p", b: "ok" });
        expect(result.resolved).toEqual(["b"]);
        expect(result.pending).toEqual(["a"]);
    });
});
