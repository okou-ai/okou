import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpCreateChatThreadOutputSchema } from "../mcp-chat-creation";

const id = "00000000-0000-0000-0000-000000000000";
const timestamp = "2026-09-20T00:00:00.000Z";

const baseOutput = {
  threadId: id,
  agentId: id,
  title: null,
  titleTruncated: false,
  model: {
    selectedModel: null,
    effectiveModel: null,
    source: null,
    admission: "checked_on_send" as const,
  },
  serviceTier: null,
  createdAt: timestamp,
  url: `https://app.okou.ai/chats/${id}`,
  replayed: false,
  retryUntil: timestamp,
};

const input = {
  inputRef: { threadId: id, eventId: "event-1", seqId: 1 },
  acceptedAt: timestamp,
  retryUntil: timestamp,
  disposition: "queued" as const,
  runId: null,
};

describe("MCP chat creation output", () => {
  it("publishes shared creation fields only once", () => {
    expect(z.toJSONSchema(mcpCreateChatThreadOutputSchema)).toMatchObject({
      type: "object",
      properties: {
        threadId: { type: "string", format: "uuid" },
        input: { type: "object" },
        nextAction: {
          anyOf: [
            {
              properties: { tool: { const: "send_chat_message" } },
            },
            {
              properties: { tool: { const: "get_chat_status" } },
            },
          ],
        },
      },
    });
  });

  it("accepts only the matching input and next-action branches", () => {
    const empty = {
      ...baseOutput,
      nextAction: {
        tool: "send_chat_message" as const,
        arguments: { threadId: id },
      },
    };
    const combined = {
      ...baseOutput,
      input,
      nextAction: {
        tool: "get_chat_status" as const,
        arguments: { threadId: id, inputRef: input.inputRef },
      },
    };

    expect(mcpCreateChatThreadOutputSchema.safeParse(empty).success).toBe(true);
    expect(mcpCreateChatThreadOutputSchema.safeParse(combined).success).toBe(
      true,
    );
    expect(
      mcpCreateChatThreadOutputSchema.safeParse({ ...empty, input }).success,
    ).toBe(false);
    const { input: _input, ...combinedWithoutInput } = combined;
    expect(
      mcpCreateChatThreadOutputSchema.safeParse(combinedWithoutInput).success,
    ).toBe(false);
  });
});
