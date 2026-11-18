import { iso, number, object, string, uuid, enum as zEnum } from "zod";
import { getStartedClaimStatusSchema } from "./get-started";

/** Financial settlement evidence remains App-owned after campaign queries move. */
export const getStartedReceiptSchema = object({
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
  memberCreditGrantId: uuid().nullable(),
  orgCreditRecordId: uuid().nullable(),
  grantedAt: iso.datetime().nullable(),
  expiresAt: iso.datetime().nullable(),
  createdAt: iso.datetime(),
  updatedAt: iso.datetime(),
});
