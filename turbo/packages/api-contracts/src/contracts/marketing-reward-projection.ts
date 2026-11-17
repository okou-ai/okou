import { literal, object, uuid, enum as zEnum } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  marketingRewardIntentSchema,
  marketingRewardReceiptSchema,
} from "./marketing-reward-settlement";

export const marketingRewardProjectionContract = initContract().router({
  notify: {
    method: "POST",
    path: "/api/internal/marketing/get-started/projections",
    headers: authHeadersSchema,
    body: object({
      version: literal(1),
      intent: marketingRewardIntentSchema,
      receipt: marketingRewardReceiptSchema,
    }).strict(),
    responses: {
      200: object({
        version: literal(1),
        environment: zEnum(["production", "preview", "development"]),
        intentId: uuid(),
        receiptId: uuid(),
        notificationId: uuid(),
      }).strict(),
      400: apiErrorSchema,
      401: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Queue a durable refresh only after Marketing stored the confirmed financial receipt",
  },
});
