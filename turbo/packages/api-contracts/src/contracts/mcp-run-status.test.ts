import { describe, expect, it } from "vitest";
import { getRunResponseSchema } from "./runs";
import {
  mcpGetRunStatusInputSchema,
  mcpGetRunStatusOutputSchema,
} from "./mcp-run-status";
const id = "00000000-0000-4000-8000-000000000001";
describe("MCP native Run reads", () => {
  it("reuses the Web Run response schema without deriving another lifecycle", () => {
    expect(mcpGetRunStatusOutputSchema).toBe(getRunResponseSchema);
    expect(mcpGetRunStatusInputSchema.parse({ runId: id })).toEqual({
      runId: id,
    });
  });
});
