import { describe, expect, it } from "vitest";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { EnvVarSplitter } from "./env-var-splitter.js";

describe("EnvVarSplitter", () => {
  const splitter = new EnvVarSplitter();

  /**
   * A legal environment variable name is also read whole as one, and the text
   * stays unread for the other splitters.
   *
   * split("SOUS_VAR_API_URL")
   * // -> [the same state, a finished envVar ref]
   */
  it("should add an envVar reading and keep the text unread", () => {
    const state = stateOf("SOUS_VAR_API_URL");
    const out = splitter.split(state);
    expect(out[0]).toBe(state);
    expect(out[1]?.ref).toEqual({ kind: "envVar", name: "SOUS_VAR_API_URL" });
    expect(out[1]?.rest).toBe("");
  });

  /**
   * Text that is not a legal name, or that carries a qualifier or a range,
   * is not an environment variable name.
   *
   * split("workflow/alpha") // -> the same state
   */
  it("should pass anything else through unchanged", () => {
    for (const state of [
      stateOf("workflow/alpha"),
      stateOf("1abc"),
      stateOf("NAME", { range: "^1" }),
      stateOf("NAME", { repo: { kind: "repo", name: "r" } }),
    ]) {
      expect(splitter.split(state)).toEqual([state]);
    }
  });

  /**
   * Query values ride along on the finished ref.
   *
   * split("NAME" with vars { a: "1" }) // -> envVar ref with vars
   */
  it("should carry the query values", () => {
    const out = splitter.split(stateOf("NAME", { vars: { a: "1" } }));
    expect(out[1]?.ref).toEqual({ kind: "envVar", name: "NAME", vars: { a: "1" } });
  });
});
