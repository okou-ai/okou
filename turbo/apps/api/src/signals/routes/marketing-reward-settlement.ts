import { marketingRewardReceipt } from "../services/marketing-reward-receipt";
import { marketingRewardSettlementContract } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { command } from "ccstate";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { marketingRewardIntentIdentity } from "../../lib/marketing-reward-intent-identity";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { resolveMarketingRewardIntent$ } from "../services/marketing-reward-settlement.service";

function rewardIntentHandler(apply: boolean) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const secret = env("MARKETING_REWARDS_SETTLEMENT_SECRET");
    if (!secret || secret.length < 32) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Reward settlement is not configured",
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
      return createErrorResponse(
        "UNAUTHORIZED",
        "Invalid reward settlement credential",
      );
    }
    const body = await get(
      bodyResultOf(marketingRewardSettlementContract.settle),
    );
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const intent = body.data;
    if (
      intent.environment !== env("ENV") ||
      marketingRewardIntentIdentity(intent) !== intent.id.toLowerCase()
    ) {
      return createErrorResponse(
        "CONFLICT",
        "Reward request identity or environment mismatch",
      );
    }
    const result = await set(
      resolveMarketingRewardIntent$,
      { intent, apply },
      signal,
    );
    if (result.kind !== "receipt") {
      return result.kind === "missing"
        ? createErrorResponse(
            "NOT_FOUND",
            "Reward source or financial receipt not found",
          )
        : createErrorResponse(
            "CONFLICT",
            "Reward request does not match its source or financial identity",
          );
    }
    const claim = result.claim;
    const status = claim.status;
    if (
      status === "granted" ||
      status === "ineligible" ||
      status === "rejected"
    ) {
      return {
        status: 200 as const,
        body: {
          version: 1 as const,
          environment: env("ENV"),
          intentId: intent.id,
          receipt: { ...marketingRewardReceipt(claim), status },
        },
      };
    }
    return {
      status: 202 as const,
      body: {
        version: 1 as const,
        environment: env("ENV"),
        intentId: intent.id,
        status: "pending" as const,
      },
    };
  });
}

const settle$ = rewardIntentHandler(true);
const lookup$ = rewardIntentHandler(false);

export const marketingRewardSettlementRoutes: readonly RouteEntry[] = [
  {
    route: marketingRewardSettlementContract.settle,
    handler: settle$,
    requestBodyPolicy: {
      maxBytes: 64 * 1024,
      tooLargeMessage: "Reward request is too large",
    },
  },
  {
    route: marketingRewardSettlementContract.lookup,
    handler: lookup$,
    requestBodyPolicy: {
      maxBytes: 64 * 1024,
      tooLargeMessage: "Reward request is too large",
    },
  },
];
