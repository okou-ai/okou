import {
  boolean,
  discriminatedUnion,
  literal,
  object,
  string,
  uuid,
  enum as zEnum,
  type output,
} from "zod";

import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const nonblank = (limit: number) => {
  return string().refine(
    (value) => {
      return (
        value.length <= limit * 2 &&
        value.trim().length > 0 &&
        [...value].length <= limit
      );
    },
    {
      message: `Must contain nonblank text of at most ${limit} Unicode characters`,
    },
  );
};

export const notifyMailSubjectSchema = nonblank(180).refine(
  (value) => {
    return !/[\r\n]/u.test(value);
  },
  {
    message: "Subject must not contain line breaks",
  },
);
export const notifyMailTextSchema = nonblank(8000);
const idempotencyKeySchema = string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:/-]+$/u);
const notifyMailFields = {
  to: literal("me").default("me"),
  subject: notifyMailSubjectSchema,
  text: notifyMailTextSchema,
};

export const notifyMailBodySchema = discriminatedUnion("kind", [
  object({
    ...notifyMailFields,
    kind: literal("notification").default("notification"),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  // Okou derives a Morning Brief key from the Run's automation event.
  object({
    ...notifyMailFields,
    kind: literal("morning-brief"),
  }).strict(),
]);

export const notificationReasonSchema = zEnum([
  "unsubscribed",
  "suppressed",
  "no-email",
  "expired",
  "delivery-failed",
]);
export const notificationResponseSchema = object({
  notificationId: uuid(),
  channel: literal("mail"),
  recipient: literal("me"),
  status: zEnum(["queued", "sent", "skipped", "failed"]),
  reason: notificationReasonSchema.nullable(),
  deduplicated: boolean(),
});
export type NotifyMailBody = output<typeof notifyMailBodySchema>;
export type NotificationResponse = output<typeof notificationResponseSchema>;

export const notificationsContract = c.router({
  mail: {
    method: "POST",
    path: "/api/notifications/mail",
    headers: authHeadersSchema,
    body: notifyMailBodySchema,
    responses: {
      200: notificationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Queue an agent-authored email to the current run's user",
  },
  get: {
    method: "GET",
    path: "/api/notifications/:id",
    pathParams: object({ id: uuid() }),
    headers: authHeadersSchema,
    responses: {
      200: notificationResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Read a notification owned by the current user and workspace",
  },
});
