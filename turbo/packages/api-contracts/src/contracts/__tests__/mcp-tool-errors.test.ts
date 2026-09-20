import { describe, expect, it } from "vitest";

import {
  MCP_TOOL_ERROR_MAX_ISSUES,
  mcpToolErrorContentSchema,
} from "../mcp-tool-errors";

describe("MCP tool errors", () => {
  it("accepts a structured field error", () => {
    expect(
      mcpToolErrorContentSchema.parse({
        error: {
          code: "invalid_arguments",
          message: "Invalid tool arguments.",
          retryable: false,
          issues: [
            {
              path: ["filter", "limit"],
              code: "too_big",
              message: "Expected a value no greater than 50",
            },
          ],
        },
      }),
    ).toStrictEqual({
      error: {
        code: "invalid_arguments",
        message: "Invalid tool arguments.",
        retryable: false,
        issues: [
          {
            path: ["filter", "limit"],
            code: "too_big",
            message: "Expected a value no greater than 50",
          },
        ],
      },
    });
  });

  it("rejects unstable codes, extra fields, and unbounded issues", () => {
    const base = {
      error: {
        code: "invalid_arguments",
        message: "Invalid tool arguments.",
        retryable: false,
      },
    };
    expect(
      mcpToolErrorContentSchema.safeParse({
        error: { ...base.error, code: "Invalid Arguments" },
      }).success,
    ).toBe(false);
    expect(
      mcpToolErrorContentSchema.safeParse({ ...base, internal: "secret" })
        .success,
    ).toBe(false);
    expect(
      mcpToolErrorContentSchema.safeParse({
        error: {
          ...base.error,
          issues: Array.from({ length: MCP_TOOL_ERROR_MAX_ISSUES + 1 }, () => {
            return { path: [], code: "invalid", message: "Invalid value" };
          }),
        },
      }).success,
    ).toBe(false);
  });
});
