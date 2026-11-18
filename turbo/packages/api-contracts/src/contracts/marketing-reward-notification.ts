import {
  discriminatedUnion,
  literal,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  marketingRewardIntentSchema,
  marketingRewardReceiptSchema,
} from "./marketing-reward-settlement";

export const marketingRewardProgressSourceSchema = discriminatedUnion("kind", [
  object({ kind: literal("event"), eventId: uuid() }).strict(),
  object({
    kind: literal("invitation-claim"),
    claimId: uuid(),
    invitationId: string().min(1).max(256),
  }).strict(),
]);

export const marketingRewardNotificationContract = initContract().router({
  notify: {
    method: "POST",
    path: "/api/internal/marketing/get-started/notifications",
    headers: authHeadersSchema,
    body: discriminatedUnion("kind", [
      object({
        kind: literal("settlement"),
        version: literal(1),
        intent: marketingRewardIntentSchema,
        receipt: marketingRewardReceiptSchema,
      }).strict(),
      object({
        kind: literal("progress"),
        version: literal(1),
        environment: zEnum(["production", "preview", "development"]),
        source: marketingRewardProgressSourceSchema,
      }).strict(),
    ]),
    responses: {
      200: union([
        object({
          version: literal(1),
          environment: zEnum(["production", "preview", "development"]),
          intentId: uuid(),
          receiptId: uuid(),
          notificationId: uuid(),
        }).strict(),
        object({
          version: literal(1),
          environment: zEnum(["production", "preview", "development"]),
          source: marketingRewardProgressSourceSchema,
          notificationId: uuid(),
        }).strict(),
      ]),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Queue a durable reward refresh from a confirmed financial receipt or retained progress source",
  },
});
