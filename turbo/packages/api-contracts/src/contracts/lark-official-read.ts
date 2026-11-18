import {
  array,
  boolean,
  coerce,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { feishuHistoryMessageSchema } from "../validators/feishu-history";

const c = initContract();
export const larkChatListQuerySchema = object({
  limit: coerce.number().int().min(1).max(50).default(20),
  cursor: string().min(1).optional(),
});
export const larkMessageHistoryQuerySchema = larkChatListQuerySchema.extend({
  chat: string().min(1),
  startTime: string().regex(/^\d+$/u).optional(),
  endTime: string().regex(/^\d+$/u).optional(),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  502: apiErrorSchema,
};

export const larkOfficialReadContract = c.router({
  listChats: {
    method: "GET",
    path: "/api/integrations/lark/official/chats",
    headers: authHeadersSchema,
    query: larkChatListQuerySchema,
    responses: {
      200: object({
        installationId: uuid(),
        chats: array(
          object({ id: string(), name: string(), chatUrl: string() }),
        ),
        hasMore: boolean(),
        nextCursor: string().nullable(),
      }),
      ...errors,
    },
    summary:
      "List group chats shared by your account and the Official Lark bot",
  },
  history: {
    method: "GET",
    path: "/api/integrations/lark/official/messages",
    headers: authHeadersSchema,
    query: larkMessageHistoryQuerySchema,
    responses: {
      200: object({
        installationId: uuid(),
        chat: string(),
        chatUrl: string(),
        messages: array(feishuHistoryMessageSchema),
        hasMore: boolean(),
        nextCursor: string().nullable(),
      }),
      ...errors,
    },
    summary: "Read shared group chat history as the Official Lark bot",
  },
});
export type LarkChatListQuery = zInfer<typeof larkChatListQuerySchema>;
export type LarkMessageHistoryQuery = zInfer<
  typeof larkMessageHistoryQuerySchema
>;
