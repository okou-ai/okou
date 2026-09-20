import { z } from "zod";

import { chatThreadServiceTierSchema } from "./chat-threads";
import { mcpChatThreadSchema } from "./mcp-chat-threads";
import { supportedRunModelSchema } from "./model-providers";

export const mcpUpdateChatThreadInputSchema = z.strictObject({
  requestId: z.uuid().toLowerCase(),
  threadId: z.uuid().toLowerCase(),
  patch: z
    .strictObject({
      title: z
        .string()
        .min(1)
        .max(200)
        .refine((title) => {
          return title.trim().length > 0;
        }, "Provide a nonblank title")
        .optional(),
      model: supportedRunModelSchema.nullable().optional(),
    })
    .refine(
      (patch) => {
        return Object.hasOwn(patch, "title") || Object.hasOwn(patch, "model");
      },
      { message: "Provide title and/or model" },
    ),
});

export const mcpUpdateChatThreadOutputSchema = z.strictObject({
  requestId: z.uuid(),
  threadId: z.uuid(),
  title: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  model: mcpChatThreadSchema.shape.model,
  serviceTier: chatThreadServiceTierSchema.nullable(),
  updatedAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime(),
  retryUntil: z.iso.datetime(),
  replayed: z.boolean(),
  url: z.url(),
});

export type McpUpdateChatThreadInput = z.infer<
  typeof mcpUpdateChatThreadInputSchema
>;
export type McpUpdateChatThreadOutput = z.infer<
  typeof mcpUpdateChatThreadOutputSchema
>;
