import { describe, expect, it } from "vitest";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";
import { constraintHints, validateAnswer } from "./validate.js";

/** Builds a variable definition with the defaults the schema applies. */
function definition(overrides: Partial<VariableDefinition> = {}): VariableDefinition {
  return {
    name: "apiUrl",
    type: "string",
    prompt: "Which API?",
    description: "The service every request this recipe generates is sent to.",
    example: "https://api.example.com",
    required: true,
    secret: false,
    scope: "shared",
    ...overrides,
  } as VariableDefinition;
}

describe("validateAnswer()", () => {
  /**
   * validateAnswer should accept an answer that satisfies the definition and
   * return the coerced value, trimmed.
   *
   * validateAnswer(stringDefinition, "  hello  ");
   * // -> { ok: true, value: "hello" }
   */
  it("should accept a valid string answer and trim it", () => {
    expect(validateAnswer(definition(), "  hello  ")).toEqual({ ok: true, value: "hello" });
  });

  /**
   * validateAnswer should refuse an empty answer to a required variable, with a
   * message naming the variable and the constraint.
   */
  it("should refuse an empty answer to a required variable", () => {
    const result = validateAnswer(definition(), "   ");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toBe("apiUrl must not be empty.");
  });

  /**
   * validateAnswer should accept an empty answer to an optional variable, since
   * an optional variable with no answer is a legitimate state.
   */
  it("should accept an empty answer to an optional variable", () => {
    expect(validateAnswer(definition({ required: false }), "")).toEqual({ ok: true, value: "" });
  });

  /**
   * validateAnswer should coerce a numeric answer and enforce its bounds,
   * naming the bound that was violated.
   *
   * validateAnswer(numberDefinition, "42");   // -> { ok: true, value: 42 }
   * validateAnswer(numberDefinition, "500");  // -> { ok: false, message: "... at most 100." }
   */
  it("should coerce a number and enforce its bounds", () => {
    const numeric = definition({ type: "number", validate: { min: 1, max: 100 } });
    expect(validateAnswer(numeric, "42")).toEqual({ ok: true, value: 42 });

    const tooBig = validateAnswer(numeric, "500");
    expect(tooBig.ok === false && tooBig.message).toBe("apiUrl must be at most 100.");

    const notANumber = validateAnswer(numeric, "twelve");
    expect(notANumber.ok === false && notANumber.message).toBe("apiUrl must be a number.");
  });

  /**
   * validateAnswer should read the words people actually type for a boolean and
   * coerce them to true or false.
   *
   * validateAnswer(booleanDefinition, "yes");
   * // -> { ok: true, value: true }
   */
  it("should coerce the usual words for a boolean", () => {
    const flag = definition({ type: "boolean" });
    expect(validateAnswer(flag, "yes")).toEqual({ ok: true, value: true });
    expect(validateAnswer(flag, "OFF")).toEqual({ ok: true, value: false });

    const nonsense = validateAnswer(flag, "maybe");
    expect(nonsense.ok === false && nonsense.message).toBe("apiUrl must be 'true' or 'false'.");
  });

  /**
   * validateAnswer should enforce an enum's options and list them when the
   * answer is not one of them.
   */
  it("should enforce the options of an enum", () => {
    const choice = definition({ type: "enum", validate: { enum: ["red", "blue"] } });
    expect(validateAnswer(choice, "red")).toEqual({ ok: true, value: "red" });

    const wrong = validateAnswer(choice, "green");
    expect(wrong.ok === false && wrong.message).toBe("apiUrl must be one of: red, blue.");
  });

  /**
   * validateAnswer should require a scheme on a url answer, since a bare
   * hostname is not something sous can hand to a fetch.
   */
  it("should require a scheme on a url", () => {
    const url = definition({ type: "url" });
    expect(validateAnswer(url, "https://example.com")).toEqual({
      ok: true,
      value: "https://example.com",
    });

    const bare = validateAnswer(url, "example.com");
    expect(bare.ok === false && bare.message).toMatch(/must be a URL/);
  });

  /**
   * validateAnswer should enforce a declared pattern and name it, so the person
   * answering can see what shape is expected.
   */
  it("should enforce a declared pattern", () => {
    const token = definition({ validate: { pattern: "^ghp_[A-Za-z0-9]+$" } });
    expect(validateAnswer(token, "ghp_abc123").ok).toBe(true);

    const wrong = validateAnswer(token, "nope");
    expect(wrong.ok === false && wrong.message).toBe(
      "apiUrl must match the pattern ^ghp_[A-Za-z0-9]+$."
    );
  });

  /**
   * validateAnswer should enforce declared string lengths.
   */
  it("should enforce declared string lengths", () => {
    const short = definition({ validate: { minLength: 4, maxLength: 6 } });
    expect(validateAnswer(short, "abcde").ok).toBe(true);

    const tooShort = validateAnswer(short, "abc");
    expect(tooShort.ok === false && tooShort.message).toBe(
      "apiUrl must be at least 4 characters long."
    );
  });
});

describe("constraintHints()", () => {
  /**
   * constraintHints should accept a definition and return short, plain-language
   * hints to show beside the question.
   *
   * constraintHints({ type: "enum", validate: { enum: ["red", "blue"] }, ... });
   * // -> ["type: enum", "one of: red, blue"]
   */
  it("should summarize the declared constraints", () => {
    const hints = constraintHints(
      definition({ type: "enum", validate: { enum: ["red", "blue"] }, required: false })
    );
    expect(hints).toEqual(["type: enum", "one of: red, blue", "optional"]);
  });
});
