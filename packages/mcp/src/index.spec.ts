import { describe, expect, it } from "vitest";
import { MCP_PACKAGE_NAME } from "./index.js";

describe("@sous/mcp", () => {
  it("exports its package name", () => {
    expect(MCP_PACKAGE_NAME).toBe("@sous/mcp");
  });
});
