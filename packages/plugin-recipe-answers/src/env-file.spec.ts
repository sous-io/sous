import { describe, expect, it } from "vitest";
import { resolveEnvFile } from "./env-file.js";

const paths = { shared: "/p/.sous/.env", local: "/p/.sous/.env.local" } as const;

describe("resolveEnvFile()", () => {
    /** Every spelling that names one of the two files should resolve to it. */
    it.each([
        [".env", "shared"],
        [".sous/.env", "shared"],
        ["./.sous/.env", "shared"],
        ["/p/.sous/.env", "shared"],
        [".env.local", "local"],
        [".sous/.env.local", "local"],
        ["/p/.sous/.env.local", "local"],
    ])("should read %s as the %s file", (value, kind) => {
        expect(resolveEnvFile(value, paths, "/p")).toBe(kind);
    });

    /** Any other file should be refused, naming the two allowed ones. */
    it("should refuse any other file, naming the allowed two", () => {
        expect(() => resolveEnvFile("/etc/passwd", paths, "/p")).toThrow(/\.sous\/\.env \(committed.*\.sous\/\.env\.local/s);
        expect(() => resolveEnvFile(".env.production", paths, "/p")).toThrow(/not an env file/);
    });
});
