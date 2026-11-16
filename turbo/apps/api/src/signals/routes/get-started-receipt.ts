import { getStartedReceiptContract } from "@okouai/api-contracts/contracts/get-started-receipt";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const receipt$ = computed(async (get) => {
  const { claimId } = get(pathParamsOf(getStartedReceiptContract.get));
  const [receipt] = await get(db$)
    .select({
      id: getStartedClaims.id,
      orgId: getStartedClaims.orgId,
      actorUserId: getStartedClaims.actorUserId,
      beneficiaryUserId: getStartedClaims.beneficiaryUserId,
      questKey: getStartedClaims.questKey,
      sourceKey: getStartedClaims.sourceKey,
      rewardKey: getStartedClaims.rewardKey,
      rewardSlot: getStartedClaims.rewardSlot,
      rewardTarget: getStartedClaims.rewardTarget,
      rewardAmount: getStartedClaims.rewardAmount,
      status: getStartedClaims.status,
      memberCreditGrantId: getStartedClaims.memberCreditGrantId,
      orgCreditRecordId: getStartedClaims.orgCreditRecordId,
      grantedAt: getStartedClaims.grantedAt,
      expiresAt: getStartedClaims.expiresAt,
      createdAt: getStartedClaims.createdAt,
      updatedAt: getStartedClaims.updatedAt,
    })
    .from(getStartedClaims)
    .where(eq(getStartedClaims.id, claimId))
    .limit(1);
  return receipt;
});

const readReceipt$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_RECEIPT_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Reward receipt lookup is not configured",
        },
      },
    };
  }
  const supplied = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return {
      status: 401 as const,
      body: {
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid reward receipt credential",
        },
      },
    };
  }
  const receipt = await get(receipt$);
  signal.throwIfAborted();
  if (!receipt) {
    return {
      status: 404 as const,
      body: {
        error: { code: "NOT_FOUND", message: "Reward receipt not found" },
      },
    };
  }
  return {
    status: 200 as const,
    body: {
      version: 1 as const,
      environment: env("ENV"),
      receipt: {
        ...receipt,
        grantedAt: receipt.grantedAt?.toISOString() ?? null,
        expiresAt: receipt.expiresAt?.toISOString() ?? null,
        createdAt: receipt.createdAt.toISOString(),
        updatedAt: receipt.updatedAt.toISOString(),
      },
    },
  };
});

export const getStartedReceiptRoutes: readonly RouteEntry[] = [
  { route: getStartedReceiptContract.get, handler: readReceipt$ },
];
