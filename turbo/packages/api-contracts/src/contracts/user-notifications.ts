import {
  array,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as Infer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { userNotificationPayloadSchema } from "../validators/user-notifications";

const c = initContract();

export const userNotificationCursorSchema = object({
  createdAt: iso.datetime(),
  id: uuid(),
});

export const userNotificationSummarySchema = object({
  id: uuid(),
  type: literal("rich_text"),
  title: string().min(1).max(200),
  summary: string().max(500),
  createdAt: iso.datetime(),
  readAt: iso.datetime().nullable(),
});

export const userNotificationSchema = userNotificationSummarySchema
  .omit({ type: true })
  .extend({
    payload: userNotificationPayloadSchema,
  });
export type UserNotification = Infer<typeof userNotificationSchema>;
export type UserNotificationSummary = Infer<
  typeof userNotificationSummarySchema
>;

export const userNotificationsContract = c.router({
  summary: {
    method: "GET",
    path: "/api/user-notifications/summary",
    headers: authHeadersSchema,
    responses: {
      200: object({ unreadCount: number().int().nonnegative() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Read your unread in-app notification count",
  },
  list: {
    method: "GET",
    path: "/api/user-notifications",
    headers: authHeadersSchema,
    query: object({
      beforeAt: iso.datetime().optional(),
      beforeId: uuid().optional(),
    }),
    responses: {
      200: object({
        items: array(userNotificationSummarySchema),
        nextCursor: userNotificationCursorSchema.nullable(),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "List your notifications, newest first",
  },
  get: {
    method: "GET",
    path: "/api/user-notifications/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: {
      200: userNotificationSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Read one notification without changing its read receipt",
  },
  markRead: {
    method: "POST",
    path: "/api/user-notifications/:id/read",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    body: c.noBody(),
    responses: {
      200: object({ readAt: iso.datetime() }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Mark a displayed notification as read; never approve an action",
  },
  markAllRead: {
    method: "POST",
    path: "/api/user-notifications/read-all",
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: {
      200: object({ readThrough: iso.datetime() }),
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Mark your existing notifications as read without deleting them",
  },
});
