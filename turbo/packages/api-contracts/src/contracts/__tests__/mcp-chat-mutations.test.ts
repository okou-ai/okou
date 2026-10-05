import { describe, expect, it } from "vitest";
import {
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageInputSchema,
  mcpRevokeQueuedMessageOutputSchema,
} from "../mcp-chat-mutations";
const threadId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
describe("MCP mutation correlation", () => {
  it("acknowledges the original input identity and acceptance time", () => {
    const output = { threadId, eventId, createdAt: "2026-10-05T00:00:00.000Z" };
    expect(mcpSendChatMessageOutputSchema.parse(output)).toEqual(output);
    expect(
      mcpSendChatMessageOutputSchema.safeParse({ threadId, eventId }).success,
    ).toBe(false);
  });
  it("recalls and acknowledges the same stable input identity", () => {
    const input = { agentId: threadId, threadId, eventId };
    expect(mcpRevokeQueuedMessageInputSchema.parse(input)).toEqual(input);
    const output = { threadId, eventId, createdAt: "2026-10-05T01:00:00.000Z" };
    expect(mcpRevokeQueuedMessageOutputSchema.parse(output)).toEqual(output);
  });
});
