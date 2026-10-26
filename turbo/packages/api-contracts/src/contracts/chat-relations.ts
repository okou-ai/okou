import {
  array,
  number,
  object,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { userMessageDocumentSchema } from "./chat-threads";

const relatedChatSchema = object({
  threadId: string().uuid(),
  title: string().nullable(),
  status: zEnum(["running", "queued", "idle", "unavailable"]),
});
const createdChatSchema = relatedChatSchema.extend({
  id: string().uuid(),
  sourceRunId: string().uuid(),
  createdAt: string().datetime(),
});
const communicationSchema = relatedChatSchema.extend({
  sentCount: number().int().nonnegative(),
  receivedCount: number().int().nonnegative(),
  lastMessageAt: string().datetime(),
});
const messageSchema = object({
  id: string().uuid(),
  direction: zEnum(["sent", "received"]),
  sourceChatThreadId: string().uuid(),
  targetChatThreadId: string().uuid(),
  sourceRunId: string().uuid(),
  targetRunId: string().uuid().nullable(),
  messageEventId: string().uuid(),
  createdAt: string().datetime(),
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
    pathParams: object({ id: string().uuid() }),
    responses: {
      200: object({
        items: array(createdChatSchema),
      }),
      ...errors,
    },
  },
  communications: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    responses: {
      200: object({
        items: array(communicationSchema),
      }),
      ...errors,
    },
  },
  messages: {
    method: "GET",
    path: "/api/chat-threads/:id/relations/communications/:peerId/messages",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid(), peerId: string().uuid() }),
    responses: {
      200: object({
        items: array(messageSchema),
      }),
      ...errors,
    },
  },
});
export type RelatedChat = zInfer<typeof relatedChatSchema>;
export type CreatedChatRelation = zInfer<typeof createdChatSchema>;
export type ChatCommunication = zInfer<typeof communicationSchema>;
export type ChatRelationMessage = zInfer<typeof messageSchema>;
