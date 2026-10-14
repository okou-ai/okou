import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { userMessageDocumentSchema } from "./chat-threads";

const cursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});
function paginationQuery(defaultLimit: number) {
  return z
    .object({
      limit: z.coerce.number().int().min(1).max(50).default(defaultLimit),
      before: z.string().datetime().optional(),
      beforeId: z.string().uuid().optional(),
    })
    .refine((query) => {
      return (query.before === undefined) === (query.beforeId === undefined);
    }, "Both cursor fields are required");
}
const relatedChatSchema = z.object({
  threadId: z.string().uuid(),
  title: z.string().nullable(),
  status: z.enum(["running", "queued", "idle", "unavailable"]),
});
const createdChatSchema = relatedChatSchema.extend({
  id: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  createdAt: z.string().datetime(),
});
const communicationSchema = relatedChatSchema.extend({
  sentCount: z.number().int().nonnegative(),
  receivedCount: z.number().int().nonnegative(),
  lastMessageAt: z.string().datetime(),
});
const messageSchema = z.object({
  id: z.string().uuid(),
  direction: z.enum(["sent", "received"]),
  sourceChatThreadId: z.string().uuid(),
  targetChatThreadId: z.string().uuid(),
  sourceRunId: z.string().uuid(),
  targetRunId: z.string().uuid().nullable(),
  messageEventId: z.string().uuid(),
  createdAt: z.string().datetime(),
  userMessage: userMessageDocumentSchema.nullable(),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};
const c = initContract();
export const chatRelationsContract = c.router({
  children: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/children",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    query: paginationQuery(5),
    responses: {
      200: z.object({
        items: z.array(createdChatSchema),
        nextCursor: cursorSchema.nullable(),
      }),
      ...errors,
    },
  },
  communications: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    query: paginationQuery(5),
    responses: {
      200: z.object({
        items: z.array(communicationSchema),
        nextCursor: cursorSchema.nullable(),
      }),
      ...errors,
    },
  },
  messages: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications/:peerId/messages",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid(), peerId: z.string().uuid() }),
    query: paginationQuery(20),
    responses: {
      200: z.object({
        items: z.array(messageSchema),
        nextCursor: cursorSchema.nullable(),
      }),
      ...errors,
    },
  },
});
export type ChatRelationCursor = z.infer<typeof cursorSchema>;
export type RelatedChat = z.infer<typeof relatedChatSchema>;
export type CreatedChatRelation = z.infer<typeof createdChatSchema>;
export type ChatCommunication = z.infer<typeof communicationSchema>;
export type ChatRelationMessage = z.infer<typeof messageSchema>;
