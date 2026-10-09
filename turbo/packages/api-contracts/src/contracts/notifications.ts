import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();
const nonblank = (limit: number) => {
  return z.string().refine(
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

export const notifyMailBodySchema = z
  .object({
    to: z.literal("me").default("me"),
    kind: z.enum(["notification", "morning-brief"]).default("notification"),
    subject: nonblank(180).refine(
      (value) => {
        return !/[\r\n]/u.test(value);
      },
      {
        message: "Subject must not contain line breaks",
      },
    ),
    text: nonblank(8000),
    idempotencyKey: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:/-]+$/u),
  })
  .strict();

export const notificationReasonSchema = z.enum([
  "unsubscribed",
  "suppressed",
  "no-email",
  "expired",
  "delivery-failed",
]);
export const notificationResponseSchema = z.object({
  notificationId: z.uuid(),
  channel: z.literal("mail"),
  recipient: z.literal("me"),
  status: z.enum(["queued", "sent", "skipped", "failed"]),
  reason: notificationReasonSchema.nullable(),
  deduplicated: z.boolean(),
});
export type NotifyMailBody = z.output<typeof notifyMailBodySchema>;
export type NotificationResponse = z.output<typeof notificationResponseSchema>;

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
    pathParams: z.object({ id: z.uuid() }),
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
