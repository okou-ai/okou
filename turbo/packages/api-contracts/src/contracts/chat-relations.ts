import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { userMessageDocumentSchema } from "./chat-threads";

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
    responses: {
      200: z.object({
        items: z.array(createdChatSchema),
      }),
      ...errors,
    },
  },
  communications: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      200: z.object({
        items: z.array(communicationSchema),
      }),
      ...errors,
    },
  },
  messages: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications/:peerId/messages",
    headers: authHeadersSchema,
    pathParams: z.object({ id: z.string().uuid(), peerId: z.string().uuid() }),
    responses: {
      200: z.object({
        items: z.array(messageSchema),
      }),
      ...errors,
    },
  },
});
export type RelatedChat = z.infer<typeof relatedChatSchema>;
export type CreatedChatRelation = z.infer<typeof createdChatSchema>;
export type ChatCommunication = z.infer<typeof communicationSchema>;
export type ChatRelationMessage = z.infer<typeof messageSchema>;
