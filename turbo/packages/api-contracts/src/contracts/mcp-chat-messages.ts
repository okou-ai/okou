import { z } from "zod";

const messageAnchorSchema = z
  .strictObject({
    eventId: z.string().min(1).max(256).optional(),
    seqId: z.number().int().positive().optional(),
  })
  .refine(
    (anchor) => {
      return anchor.eventId !== undefined || anchor.seqId !== undefined;
    },
    {
      message: "Provide eventId or seqId from a real message reference",
    },
  );

export const mcpGetChatMessagesInputSchema = z
  .strictObject({
    threadId: z.uuid(),
    runId: z.string().min(1).max(256).optional(),
    around: messageAnchorSchema.optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .refine(
    (input) => {
      return !(input.around && input.cursor);
    },
    {
      message:
        "Use around only for the first page; continue with cursor and the same threadId, runId and limit",
    },
  );

const messageFileSchema = z.strictObject({
  fileId: z.string().min(1),
  filename: z.string().min(1),
  contentType: z.string().min(1),
  annotatedFileId: z.string().min(1).optional(),
});

export const mcpChatMessageSchema = z.strictObject({
  ref: z.strictObject({
    threadId: z.uuid(),
    eventId: z.string().min(1),
    seqId: z.number().int().positive(),
  }),
  role: z.enum(["user", "assistant"]),
  eventType: z.enum(["input.prompt", "input.rejected", "output.message"]),
  createdAt: z.string(),
  runId: z.string().nullable(),
  text: z.string().max(8192),
  textOffset: z.number().int().nonnegative(),
  textComplete: z.boolean(),
  files: z.array(messageFileSchema).max(8),
  fileOffset: z.number().int().nonnegative(),
  filesComplete: z.boolean(),
  nextContentCursor: z.string().nullable(),
  url: z.url(),
});

export const mcpGetChatMessagesOutputSchema = z.strictObject({
  messages: z.array(mcpChatMessageSchema).max(50),
  olderCursor: z.string().nullable(),
  newerCursor: z.string().nullable(),
});

export type McpGetChatMessagesInput = z.infer<
  typeof mcpGetChatMessagesInputSchema
>;
export type McpGetChatMessagesOutput = z.infer<
  typeof mcpGetChatMessagesOutputSchema
>;
export type McpChatMessage = z.infer<typeof mcpChatMessageSchema>;
export type McpMessageReadResult =
  | { readonly kind: "ok"; readonly data: McpGetChatMessagesOutput }
  | {
      readonly kind:
        | "invalid_cursor"
        | "not_found"
        | "view_changed"
        | "reference_unavailable"
        | "history_limit"
        | "history_unavailable";
      readonly message: string;
    };
