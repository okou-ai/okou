import { literal, object, uuid, enum as zEnum } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { getStartedHistoryRecordSchema } from "./get-started-history";

export const getStartedReceiptSchema = getStartedHistoryRecordSchema.pick({
  id: true,
  orgId: true,
  actorUserId: true,
  beneficiaryUserId: true,
  questKey: true,
  sourceKey: true,
  rewardKey: true,
  rewardSlot: true,
  rewardTarget: true,
  rewardAmount: true,
  status: true,
  memberCreditGrantId: true,
  orgCreditRecordId: true,
  grantedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
});

export const getStartedReceiptContract = initContract().router({
  get: {
    method: "GET",
    path: "/api/internal/marketing/get-started/receipts/:claimId",
    headers: authHeadersSchema,
    pathParams: object({ claimId: uuid() }),
    responses: {
      200: object({
        version: literal(1),
        environment: zEnum(["production", "preview", "development"]),
        receipt: getStartedReceiptSchema,
      }),
      401: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Read one persisted reward receipt with a dedicated service credential",
  },
});
