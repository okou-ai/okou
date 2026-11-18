import {
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { getStartedReceiptSchema } from "./get-started-receipt";

const marketingRewardEnvironmentSchema = zEnum([
  "production",
  "preview",
  "development",
]);

/** A durable request is pending until App returns a committed financial receipt. */
export const marketingRewardIntentSchema = object({
  version: literal(1),
  id: uuid(),
  environment: marketingRewardEnvironmentSchema,
  policy: literal("get-started-v1"),
  sourceEventId: uuid(),
  questKey: zEnum([
    "connector",
    "slack",
    "imessage",
    "workflow",
    "invite",
    "checkin",
  ]),
  sourceKey: string().min(1).max(256),
  rewardKey: string().min(1).max(512),
  orgId: string().min(1).max(256),
  actorUserId: string().min(1).max(256),
  beneficiaryUserId: string().min(1).max(256).nullable(),
  rewardTarget: zEnum(["user", "org"]),
  rewardAmount: number().int(),
  completedAt: iso.datetime(),
})
  .strict()
  .superRefine((intent, context) => {
    const amount = {
      connector: 100,
      slack: 2000,
      imessage: 1000,
      workflow: 1000,
      invite: 100,
      checkin: 100,
    }[intent.questKey];
    if (
      intent.rewardAmount !== amount ||
      (intent.questKey === "slack"
        ? intent.rewardTarget !== "org" || intent.beneficiaryUserId !== null
        : intent.rewardTarget !== "user" || intent.beneficiaryUserId === null)
    )
      context.addIssue({ code: "custom", message: "Invalid campaign terms" });
  });

export type MarketingRewardIntent = zInfer<typeof marketingRewardIntentSchema>;

export const marketingRewardReceiptSchema = getStartedReceiptSchema
  .omit({ updatedAt: true })
  .extend({
    status: zEnum(["granted", "ineligible", "rejected"]),
    reason: string().nullable(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const invalid =
      receipt.status === "granted"
        ? !receipt.rewardKey ||
          !receipt.grantedAt ||
          !receipt.expiresAt ||
          Date.parse(receipt.expiresAt) - Date.parse(receipt.grantedAt) !==
            168 * 3600_000 ||
          (receipt.rewardTarget === "user"
            ? !receipt.memberCreditGrantId || receipt.orgCreditRecordId !== null
            : !receipt.orgCreditRecordId ||
              receipt.memberCreditGrantId !== null)
        : receipt.rewardKey !== null ||
          receipt.memberCreditGrantId !== null ||
          receipt.orgCreditRecordId !== null ||
          receipt.grantedAt !== null ||
          receipt.expiresAt !== null;
    if (invalid)
      context.addIssue({
        code: "custom",
        message: "Invalid committed financial receipt",
      });
  });

const responses = Object.freeze({
  200: object({
    version: literal(1),
    environment: marketingRewardEnvironmentSchema,
    intentId: uuid(),
    receipt: marketingRewardReceiptSchema,
  }),
  202: object({
    version: literal(1),
    environment: marketingRewardEnvironmentSchema,
    intentId: uuid(),
    status: literal("pending"),
  }),
  400: apiErrorSchema,
  401: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
});

export const marketingRewardSettlementContract = initContract().router({
  settle: {
    method: "POST",
    path: "/api/internal/marketing/get-started/settlements",
    headers: authHeadersSchema,
    body: marketingRewardIntentSchema,
    responses,
    summary:
      "Settle a source-proven campaign request with a dedicated service credential",
  },
});
