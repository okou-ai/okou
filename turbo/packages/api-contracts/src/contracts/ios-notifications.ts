import {
  array,
  boolean,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
} from "zod";
import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const iosNotificationsContract = c.router({
  prefetch: {
    method: "POST",
    path: "/api/ios-notifications/prefetch",
    headers: authHeadersSchema,
    body: object({
      notificationId: string().min(1).max(128),
      threadId: uuid(),
      runId: uuid(),
      source: zEnum(["app", "extension"]),
      outcome: zEnum(["saved", "failed", "expired"]),
      durationMs: number().int().min(0).max(60000),
      lastSeqId: number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      containsRun: boolean(),
      observedAt: iso.datetime().optional(),
    }),
    responses: {
      200: object({ success: literal(true) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Report bounded diagnostic facts about iOS notification prefetch",
  },
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
      badgeClearSequence: number()
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
        badgeCount: number().int().nonnegative().optional(),
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
