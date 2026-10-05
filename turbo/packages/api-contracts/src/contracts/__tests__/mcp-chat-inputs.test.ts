import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpChatModelIdSchema } from "../mcp-chat-discovery";
import {
  mcpRevokeQueuedMessageInputSchema,
  mcpSendChatMessageInputSchema,
} from "../mcp-chat-mutations";
import { mcpGetRunStatusInputSchema } from "../mcp-run-status";
import { mcpUpdateChatThreadInputSchema } from "../mcp-chat-thread-update";
import { mcpListChatThreadsInputSchema } from "../mcp-chat-threads";
const id = "00000000-0000-4000-8000-000000000001";

describe("MCP Web input adaptation", () => {
  it("requires only the ordinary Agent and prompt, with optional thread/model", () => {
    const input = { agentId: id, prompt: "Preserved text" };
    expect(mcpSendChatMessageInputSchema.parse(input)).toEqual(input);
    expect(
      mcpSendChatMessageInputSchema.parse({
        ...input,
        threadId: id,
        model: "future/model-id",
      }),
    ).toEqual({ ...input, threadId: id, model: "future/model-id" });
    expect(z.toJSONSchema(mcpSendChatMessageInputSchema)).toMatchObject({
      type: "object",
      required: ["agentId", "prompt"],
      additionalProperties: false,
    });
  });
  it.each(["", " ", "\n\t"])("rejects blank prompt %j", (prompt) => {
    expect(
      mcpSendChatMessageInputSchema.safeParse({ agentId: id, prompt }).success,
    ).toBe(false);
  });
  it.each([
    "requestId",
    "inputRef",
    "retryUntil",
    "replayed",
    "text",
    "waitMs",
    "clientEventId",
    "orgId",
  ])("rejects old protocol or identity field %s", (field) => {
    expect(
      mcpSendChatMessageInputSchema.safeParse({
        agentId: id,
        prompt: "Text",
        [field]: id,
      }).success,
    ).toBe(false);
  });
  it("keeps model syntax separate from live catalog availability", () => {
    expect(mcpChatModelIdSchema.safeParse("future/model-id").success).toBe(
      true,
    );
    expect(mcpChatModelIdSchema.safeParse(" ").success).toBe(false);
  });
  it("retains sparse metadata and nullable model without replay identity", () => {
    for (const patch of [
      { title: "New title" },
      { model: null },
      { model: "future/model-id" },
      { title: "New title", model: null },
    ]) {
      expect(
        mcpUpdateChatThreadInputSchema.safeParse({ threadId: id, patch })
          .success,
      ).toBe(true);
    }
    for (const patch of [
      {},
      { title: " " },
      { model: "\n" },
      { extra: true },
    ]) {
      expect(
        mcpUpdateChatThreadInputSchema.safeParse({ threadId: id, patch })
          .success,
      ).toBe(false);
    }
    expect(
      mcpUpdateChatThreadInputSchema.safeParse({
        threadId: id,
        patch: { title: "Title" },
        requestId: id,
      }).success,
    ).toBe(false);
    expect(
      mcpListChatThreadsInputSchema.parse({ title: " Trimmed filter " }).title,
    ).toBe("Trimmed filter");
  });
  it("distinguishes native Run selectors from original input recall selectors", () => {
    expect(mcpGetRunStatusInputSchema.parse({ runId: id })).toEqual({
      runId: id,
    });
    expect(
      mcpRevokeQueuedMessageInputSchema.parse({
        agentId: id,
        threadId: id,
        eventId: id,
      }),
    ).toEqual({ agentId: id, threadId: id, eventId: id });
  });
});
