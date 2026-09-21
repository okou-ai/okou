import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  mcpRevokeQueuedMessageInputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpSendChatMessageOutputSchema,
} from "../mcp-chat-mutations";

const threadId = "00000000-0000-4000-8000-000000000001";
const eventId = "00000000-0000-4000-8000-000000000002";
const inputRef = { threadId, eventId, seqId: 1 };

describe("MCP chat mutation contracts", () => {
  it("publishes a ready-to-use exact-status handoff after send", () => {
    const output = {
      inputRef,
      acceptedAt: "2026-09-21T00:00:00.000000Z",
      retryUntil: "2026-09-22T00:00:00.000000Z",
      disposition: "queued" as const,
      runId: null,
      replayed: false,
      url: `https://app.okou.ai/chats/${threadId}`,
      nextAction: {
        tool: "get_chat_status" as const,
        arguments: { inputRef },
      },
    };

    expect(mcpSendChatMessageOutputSchema.parse(output)).toStrictEqual(output);
    expect(z.toJSONSchema(mcpSendChatMessageOutputSchema)).toMatchObject({
      type: "object",
      properties: {
        inputRef: { type: "object" },
        nextAction: {
          type: "object",
          properties: {
            tool: { const: "get_chat_status" },
            arguments: {
              type: "object",
              properties: { inputRef: { type: "object" } },
              required: ["inputRef"],
              additionalProperties: false,
            },
          },
        },
      },
      required: expect.arrayContaining(["inputRef", "nextAction"]),
      additionalProperties: false,
    });
  });

  it("publishes the complete input reference for revocation input and output", () => {
    expect(z.toJSONSchema(mcpRevokeQueuedMessageInputSchema)).toMatchObject({
      type: "object",
      properties: { inputRef: { type: "object" } },
      required: ["inputRef"],
      additionalProperties: false,
    });
    expect(
      mcpRevokeQueuedMessageOutputSchema.parse({
        inputRef,
        outcome: "unavailable",
        runId: null,
      }),
    ).toStrictEqual({ inputRef, outcome: "unavailable", runId: null });
  });
});
