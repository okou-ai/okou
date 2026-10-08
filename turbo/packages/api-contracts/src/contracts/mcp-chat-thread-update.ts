import { z } from "zod";

import { chatThreadServiceTierSchema } from "./chat-threads";
import { mcpChatModelIdSchema } from "./mcp-chat-discovery";
import { mcpChatOutputTimestampSchema } from "./mcp-chat-time";

export const mcpUpdateChatThreadInputSchema = z.strictObject({
  threadId: z.uuid().toLowerCase(),
  patch: z
    .strictObject({
      title: z
        .string()
        .min(1)
        .max(200)
        .regex(/\S/u, "Provide a nonblank title")
        .optional(),
      model: mcpChatModelIdSchema.nullable().optional(),
    })
    .refine(
      (patch) => {
        return Object.hasOwn(patch, "title") || Object.hasOwn(patch, "model");
      },
      { message: "Provide title and/or model" },
    )
    .meta({ minProperties: 1 }),
});

export const mcpUpdateChatThreadOutputSchema = z.strictObject({
  threadId: z.uuid(),
  title: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  selectedModel: z.string().nullable(),
  serviceTier: chatThreadServiceTierSchema.nullable(),
  metadataUpdatedAt: mcpChatOutputTimestampSchema,
  url: z.url(),
});

export type McpUpdateChatThreadInput = z.infer<
  typeof mcpUpdateChatThreadInputSchema
>;
export type McpUpdateChatThreadOutput = z.infer<
  typeof mcpUpdateChatThreadOutputSchema
>;
