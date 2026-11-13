import { array, enum as zEnum, object, uuid } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { sharedThreadAudienceSchema } from "./shared-thread-visibility";

const messageSchema = object({
  eventId: uuid(),
  role: zEnum(["user", "assistant"]),
  turnEventIds: array(uuid()),
});
export const chatShareSelectionSchema = object({
  messages: array(messageSchema),
});

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
};
const c = initContract();
export const chatShareSelectionContract = c.router({
  get: {
    method: "GET",
    path: "/api/chat-threads/:threadId/shared-threads/selection",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    responses: { 200: chatShareSelectionSchema, ...errors },
    summary:
      "Resolve shareable messages and single-answer selections from confirmed history",
  },
  create: {
    method: "POST",
    path: "/api/chat-threads/:threadId/shared-threads/selection",
    headers: authHeadersSchema,
    pathParams: object({ threadId: uuid() }),
    body: object({
      eventIds: array(uuid()).min(1),
      id: uuid(),
      audience: sharedThreadAudienceSchema,
    }),
    responses: { 201: object({ id: uuid() }), 413: apiErrorSchema, ...errors },
    summary:
      "Create a snapshot only if every selected message is still shareable",
  },
});
