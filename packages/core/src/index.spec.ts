import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_NAME } from "./index.js";

describe("@sous/core", () => {
  it("exports its package name", () => {
    expect(CORE_PACKAGE_NAME).toBe("@sous/core");
  });
});
