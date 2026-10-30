import { describe, expect, it } from "vitest";
import {
    CancelledError,
    ConfigError,
    ConflictError,
    InputError,
    isSousError,
    isSousErrorOfKind,
    LoopError,
    NonInteractiveError,
    NotFoundError,
    PluginError,
    SousError,
} from "./errors.js";

describe("SousError", () => {
    /**
     * Every sous error carries details, an exit code and a kind; subclasses set their own kind and name.
     */
    it("should carry details, exit codes and kinds", () => {
        const cause = new Error("root");
        const base = new SousError("plain", { cause, details: ["fix it"], exitCode: 3 });

        expect(base).toMatchObject({ message: "plain", name: "SousError", details: ["fix it"], exitCode: 3, sousErrorKind: "sous", cause });
        expect(new SousError("x")).toMatchObject({ details: [], exitCode: 1 });
        expect(new SousError("x").cause).toBeUndefined();
        expect(new ConfigError("c")).toMatchObject({ name: "ConfigError", sousErrorKind: "config" });
        expect(new LoopError("runDepth", "deep")).toMatchObject({ limit: "runDepth", sousErrorKind: "loop" });
        expect(new PluginError("p", "bad")).toMatchObject({ plugin: "p", sousErrorKind: "plugin" });
        expect(new ConflictError("git.runner", ["a", "b"], "two")).toMatchObject({ subject: "git.runner", plugins: ["a", "b"], sousErrorKind: "conflict" });
        expect(new NotFoundError("intent", "nope")).toMatchObject({ message: 'No plugin provides the intent "nope".', thing: "intent", id: "nope" });
        expect(new NotFoundError("intent", "nope", "custom").message).toBe("custom");
    });

    /**
     * InputError lists each issue as a detail line and exits with 2.
     */
    it("should describe input problems", () => {
        const error = new InputError("namespace.list", [{ path: "repository", message: "Expected string." }, { path: "", message: "Bad." }]);

        expect(error).toMatchObject({ intent: "namespace.list", exitCode: 2, details: ["repository: Expected string.", "Bad."] });
        expect(new InputError("x", [], { details: ["own"] }).details).toEqual(["own"]);
    });

    /**
     * NonInteractiveError names the question and the flag; CancelledError the reason and the plugin.
     */
    it("should describe unaskable questions and cancellations", () => {
        expect(new NonInteractiveError("Sure?", undefined).message).toBe('sous needed to ask "Sure?" but cannot ask questions in this run.');
        expect(new NonInteractiveError("Sure?", "--yes")).toMatchObject({ question: "Sure?", answeredBy: "--yes", exitCode: 1 });
        expect(new CancelledError("build", "no").message).toBe('"build" was cancelled: no');
        expect(new CancelledError("build", "no", "guard")).toMatchObject({ target: "build", reason: "no", cancelledBy: "guard" });
    });
});

describe("isSousError()", () => {
    /**
     * Sous errors are recognized by class, or by their kind when they come from another copy of the
     * package.
     */
    it("should recognize sous errors by class or kind", () => {
        const foreign = Object.assign(new Error("other copy"), { sousErrorKind: "config" });

        expect(isSousError(new ConfigError("x"))).toBe(true);
        expect(isSousError(foreign)).toBe(true);
        expect(isSousError(new Error("x"))).toBe(false);
        expect(isSousError("x")).toBe(false);
        expect(isSousErrorOfKind(foreign, "config")).toBe(true);
        expect(isSousErrorOfKind(new ConfigError("x"), "loop")).toBe(false);
    });
});
