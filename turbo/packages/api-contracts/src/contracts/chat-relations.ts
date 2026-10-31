import {
  array,
  iso,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { userMessageDocumentSchema } from "./chat-threads";

const relatedChatSchema = object({
  threadId: uuid(),
  title: string().nullable(),
  status: zEnum(["running", "queued", "idle", "unavailable"]),
});
const createdChatSchema = relatedChatSchema.extend({
  id: uuid(),
  sourceRunId: uuid(),
  createdAt: iso.datetime(),
});
const communicationSchema = relatedChatSchema.extend({
  sentCount: number().int().nonnegative(),
  receivedCount: number().int().nonnegative(),
  lastMessageAt: iso.datetime(),
});
const messageSchema = object({
  id: uuid(),
  direction: zEnum(["sent", "received"]),
  sourceChatThreadId: uuid(),
  targetChatThreadId: uuid(),
  sourceRunId: uuid(),
  targetRunId: uuid().nullable(),
  messageEventId: uuid(),
  createdAt: iso.datetime(),
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
    pathParams: object({ id: uuid() }),
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
    pathParams: object({ id: uuid() }),
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
    pathParams: object({ id: uuid(), peerId: uuid() }),
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
