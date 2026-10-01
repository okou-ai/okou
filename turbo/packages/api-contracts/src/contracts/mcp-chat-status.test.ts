import { describe, expect, it } from "vitest";
import { getRunResponseSchema } from "./runs";
import {
  mcpGetChatStatusInputSchema,
  mcpGetChatStatusOutputSchema,
} from "./mcp-chat-status";
const id = "00000000-0000-4000-8000-000000000001";
describe("MCP ordinary Run reads", () => {
  it("reuses the Web Run response schema without deriving another lifecycle", () => {
    expect(mcpGetChatStatusOutputSchema).toBe(getRunResponseSchema);
    expect(mcpGetChatStatusInputSchema.parse({ runId: id })).toEqual({
      runId: id,
    });
  });
  it.each([
    { threadId: id },
    { inputRef: { threadId: id, eventId: id, seqId: 1 } },
    { runId: id, waitMs: 1 },
  ])("rejects removed status selectors %j", (input) => {
    expect(mcpGetChatStatusInputSchema.safeParse(input).success).toBe(false);
  });
});
