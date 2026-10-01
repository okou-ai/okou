import { describe, expect, it } from "vitest";
import { chatEventsContract } from "../chat-threads";
import {
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageOutputSchema,
} from "../mcp-chat-mutations";
const threadId = "00000000-0000-4000-8000-000000000001";
describe("MCP mutation response parity", () => {
  it("serializes the same acceptance response as Web send/recall", () => {
    const output = {
      threadId,
      runId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    };
    expect(mcpSendChatMessageOutputSchema).toBe(
      chatEventsContract.send.responses[201],
    );
    expect(mcpRevokeQueuedMessageOutputSchema).toBe(
      chatEventsContract.send.responses[201],
    );
    expect(mcpSendChatMessageOutputSchema.parse(output)).toEqual(output);
  });
});
