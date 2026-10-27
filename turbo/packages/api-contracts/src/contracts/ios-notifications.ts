import { array, number, object, string, uuid } from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const iosNotificationsContract = c.router({
  reconcile: {
    method: "POST",
    path: "/api/ios-notifications/reconcile",
    headers: authHeadersSchema,
    body: object({
      installationId: uuid(),
      registrationRevision: number()
        .int()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
      notifications: array(
        object({
          identifier: string().min(1).max(512),
          threadId: uuid(),
          runId: uuid(),
        }),
      ).max(500),
    }),
    responses: {
      200: object({
        unreadCount: number().int().nonnegative(),
        removeIdentifiers: array(string()),
      }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary:
      "Reconcile delivered iOS notifications with the current user's read cursors",
  },
});
