import { z } from "zod";

import { chatThreadServiceTierSchema } from "./chat-threads";
import { mcpChatModelIdSchema } from "./mcp-chat-discovery";
import {
  mcpChatInputReceiptSchema,
  mcpChatMessageTextSchema,
} from "./mcp-chat-mutations";
import { mcpGetChatStatusNextActionSchema } from "./mcp-chat-references";
import { mcpChatOutputTimestampSchema } from "./mcp-chat-time";
import { mcpChatThreadSchema } from "./mcp-chat-threads";

const requestIdSchema = z.uuid().toLowerCase();
const agentIdSchema = z.uuid().toLowerCase();
const titleSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/\S/u, "Provide a nonblank title");

const createInputShape = {
  requestId: requestIdSchema,
  agentId: agentIdSchema.optional(),
  title: titleSchema.optional(),
  model: mcpChatModelIdSchema.optional(),
} as const;

export const mcpCreateEmptyChatThreadInputSchema =
  z.strictObject(createInputShape);

export const mcpCreateChatWithMessageInputSchema = z.strictObject({
  ...createInputShape,
  message: mcpChatMessageTextSchema,
});

export type McpCreateEmptyChatThreadInput = z.infer<
  typeof mcpCreateEmptyChatThreadInputSchema
>;
export type McpCreateChatWithMessageInput = z.infer<
  typeof mcpCreateChatWithMessageInputSchema
>;
export type McpCreateChatThreadInput =
  | McpCreateEmptyChatThreadInput
  | McpCreateChatWithMessageInput;

export const mcpCreateChatThreadInputSchema = z
  .strictObject({
    ...createInputShape,
    message: mcpChatMessageTextSchema.optional(),
  })
  .refine(
    (input): input is McpCreateChatThreadInput => {
      return !("message" in input) || input.message !== undefined;
    },
    { path: ["message"], message: "Message must be a string when provided" },
  );

const createOutputShape = {
  threadId: z.uuid(),
  agentId: z.uuid(),
  title: z.string().max(1000).nullable(),
  titleTruncated: z.boolean(),
  model: mcpChatThreadSchema.shape.model,
  serviceTier: chatThreadServiceTierSchema.nullable(),
  createdAt: mcpChatOutputTimestampSchema,
  url: z.url(),
  replayed: z.boolean(),
  retryUntil: mcpChatOutputTimestampSchema,
} as const;

const createOutputBaseSchema = z.strictObject(createOutputShape);
const sendMessageNextActionSchema = z.strictObject({
  tool: z.literal("send_chat_message"),
  arguments: z.strictObject({ threadId: z.uuid() }),
});
export const mcpCreateEmptyChatThreadOutputSchema =
  createOutputBaseSchema.extend({ nextAction: sendMessageNextActionSchema });

export const mcpCreateChatWithMessageOutputSchema =
  createOutputBaseSchema.extend({
    input: mcpChatInputReceiptSchema,
    nextAction: mcpGetChatStatusNextActionSchema,
  });

export type McpCreateEmptyChatThreadOutput = z.infer<
  typeof mcpCreateEmptyChatThreadOutputSchema
>;
export type McpCreateChatWithMessageOutput = z.infer<
  typeof mcpCreateChatWithMessageOutputSchema
>;
export type McpCreateChatThreadOutput =
  | McpCreateEmptyChatThreadOutput
  | McpCreateChatWithMessageOutput;

export const mcpCreateChatThreadOutputSchema = createOutputBaseSchema
  .extend({
    input: mcpChatInputReceiptSchema.optional(),
    nextAction: z.union([
      sendMessageNextActionSchema,
      mcpGetChatStatusNextActionSchema,
    ]),
  })
  .refine(
    (output): output is McpCreateChatThreadOutput => {
      return output.nextAction.tool === "get_chat_status"
        ? output.input !== undefined
        : output.input === undefined;
    },
    {
      message: "input is required only when the next action is get_chat_status",
    },
  );
