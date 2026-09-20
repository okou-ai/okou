import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpCreateChatThreadInputSchema } from "../mcp-chat-creation";
import { mcpChatModelIdSchema } from "../mcp-chat-discovery";
import { mcpSendChatMessageInputSchema } from "../mcp-chat-mutations";
import { mcpUpdateChatThreadInputSchema } from "../mcp-chat-thread-update";
import { mcpListChatThreadsInputSchema } from "../mcp-chat-threads";

const id = "00000000-0000-0000-0000-000000000000";

describe("MCP chat input schemas", () => {
  it("publishes nonblank string and nonempty patch constraints", () => {
    expect(z.toJSONSchema(mcpSendChatMessageInputSchema)).toMatchObject({
      properties: {
        text: { type: "string", maxLength: 32_000, pattern: "\\S" },
      },
    });
    expect(z.toJSONSchema(mcpCreateChatThreadInputSchema)).toMatchObject({
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
        },
        model: {
          type: "string",
          minLength: 1,
          maxLength: 255,
          pattern: "\\S",
        },
      },
    });
    expect(z.toJSONSchema(mcpUpdateChatThreadInputSchema)).toMatchObject({
      properties: {
        patch: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: {
            title: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              pattern: "\\S",
            },
            model: {
              anyOf: [
                {
                  type: "string",
                  minLength: 1,
                  maxLength: 255,
                  pattern: "\\S",
                },
                { type: "null" },
              ],
            },
          },
        },
      },
    });
    expect(z.toJSONSchema(mcpListChatThreadsInputSchema)).toMatchObject({
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          pattern: "\\S",
        },
      },
    });
  });

  it("keeps model syntax separate from live catalog availability", () => {
    for (const model of ["", " ", "\n\t"]) {
      expect(mcpChatModelIdSchema.safeParse(model).success).toBe(false);
    }
    expect(mcpChatModelIdSchema.safeParse("future/model-id").success).toBe(
      true,
    );

    const create = z.toJSONSchema(mcpCreateChatThreadInputSchema);
    const update = z.toJSONSchema(mcpUpdateChatThreadInputSchema);
    expect(JSON.stringify(create.properties?.model)).not.toContain('"enum"');
    expect(JSON.stringify(update.properties?.patch)).not.toContain('"enum"');
  });

  it("rejects blank text and titles while preserving each title transform", () => {
    const send = { threadId: id, requestId: id, text: "" };
    expect(mcpSendChatMessageInputSchema.safeParse(send).success).toBe(false);
    expect(
      mcpSendChatMessageInputSchema.safeParse({ ...send, text: " \n\t " })
        .success,
    ).toBe(false);
    expect(
      mcpSendChatMessageInputSchema.safeParse({ ...send, text: "你好" })
        .success,
    ).toBe(true);

    const create = { requestId: id, agentId: id, model: "future/model-id" };
    expect(
      mcpCreateChatThreadInputSchema.safeParse({ ...create, title: "  " })
        .success,
    ).toBe(false);
    expect(
      mcpCreateChatThreadInputSchema.parse({
        ...create,
        title: "  Preserved title  ",
      }).title,
    ).toBe("  Preserved title  ");

    expect(
      mcpListChatThreadsInputSchema.safeParse({ title: " \n\t " }).success,
    ).toBe(false);
    expect(
      mcpListChatThreadsInputSchema.parse({
        title: `${" ".repeat(250)}Trimmed filter${" ".repeat(250)}`,
      }).title,
    ).toBe("Trimmed filter");
  });

  it("retains sparse update and nullable model semantics", () => {
    const update = { requestId: id, threadId: id };
    for (const patch of [
      {},
      { title: " " },
      { model: "\n" },
      { extra: true },
    ]) {
      expect(
        mcpUpdateChatThreadInputSchema.safeParse({ ...update, patch }).success,
      ).toBe(false);
    }
    for (const patch of [
      { title: "New title" },
      { model: null },
      { model: "future/model-id" },
      { title: "New title", model: "future/model-id" },
    ]) {
      expect(
        mcpUpdateChatThreadInputSchema.safeParse({ ...update, patch }).success,
      ).toBe(true);
    }
  });
});
