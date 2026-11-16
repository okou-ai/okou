import {
  array,
  coerce,
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
import { getStartedClaimStatusSchema } from "./get-started";

/** Historical share receipts are exported, but never become active quests. */
export const getStartedHistoryRecordSchema = object({
  id: uuid(),
  orgId: string().min(1),
  actorUserId: string().min(1),
  beneficiaryUserId: string().nullable(),
  questKey: zEnum([
    "connector",
    "slack",
    "imessage",
    "workflow",
    "invite",
    "checkin",
    "share",
  ]),
  sourceKey: string().min(1),
  rewardKey: string().nullable(),
  rewardSlot: number().int().nullable(),
  rewardTarget: zEnum(["user", "org"]),
  rewardAmount: number().int().nonnegative(),
  status: getStartedClaimStatusSchema,
  invitationId: string().nullable(),
  inviteeUserId: string().nullable(),
  sourceEventId: uuid().nullable(),
  runId: uuid().nullable(),
  workflowId: uuid().nullable(),
  postUrl: string().nullable(),
  evidenceText: string().nullable(),
  reason: string().nullable(),
  attempts: number().int().nonnegative(),
  nextAttemptAt: iso.datetime(),
  completedAt: iso.datetime().nullable(),
  reviewedAt: iso.datetime().nullable(),
  memberCreditGrantId: uuid().nullable(),
  orgCreditRecordId: uuid().nullable(),
  grantedAt: iso.datetime().nullable(),
  expiresAt: iso.datetime().nullable(),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
});
export type GetStartedHistoryRecord = zInfer<
  typeof getStartedHistoryRecordSchema
>;

export const getStartedHistoryPageSchema = object({
  version: literal(1),
  environment: zEnum(["production", "preview", "development"]),
  exportedAt: iso.datetime(),
  records: array(getStartedHistoryRecordSchema).max(200),
  nextCursor: uuid().nullable(),
});

export const getStartedHistoryContract = initContract().router({
  export: {
    method: "GET",
    path: "/api/internal/marketing/get-started/history",
    headers: authHeadersSchema,
    query: object({
      after: uuid().optional(),
      limit: coerce.number().int().min(1).max(200).default(100),
    }),
    responses: {
      200: getStartedHistoryPageSchema,
      401: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary:
      "Export reward history with a dedicated read-only service credential",
  },
});
