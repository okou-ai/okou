import { marketingRewardProjectionContract } from "@okouai/api-contracts/contracts/marketing-reward-projection";
import { marketingRewardReceiptSchema } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { command } from "ccstate";
import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { marketingRewardIntentIdentity } from "../../lib/marketing-reward-intent-identity";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { enqueueBackgroundJob$ } from "../services/background-job-command.service";
import { resolveMarketingRewardIntent$ } from "../services/marketing-reward-settlement.service";
import { marketingRewardReceipt } from "../services/marketing-reward-receipt";
import { MARKETING_REWARD_PROJECTION_JOB_KIND } from "../services/marketing-reward-projection.service";

const namespace = "d3f5d0e4-76eb-45b5-a34e-620b5804297b";
const body$ = bodyResultOf(marketingRewardProjectionContract.notify);

const queueProjection$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_PROJECTION_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Reward projection refresh is not configured",
        },
      },
    };
  }
  const actual = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Invalid reward projection credential",
    );
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { intent, receipt } = body.data;
  if (
    intent.environment !== env("ENV") ||
    marketingRewardIntentIdentity(intent) !== intent.id.toLowerCase()
  ) {
    return createErrorResponse(
      "CONFLICT",
      "Reward projection request identity mismatch",
    );
  }
  const resolved = await set(
    resolveMarketingRewardIntent$,
    { intent, apply: false },
    signal,
  );
  if (resolved.kind === "missing") {
    return createErrorResponse(
      "NOT_FOUND",
      "Reward financial receipt not found",
    );
  }
  if (
    resolved.kind !== "receipt" ||
    !["granted", "ineligible", "rejected"].includes(resolved.claim.status)
  ) {
    return createErrorResponse(
      "CONFLICT",
      "Reward financial outcome is not terminal",
    );
  }
  const financial = marketingRewardReceiptSchema.parse(
    marketingRewardReceipt(resolved.claim),
  );
  if (!isDeepStrictEqual(financial, receipt)) {
    return createErrorResponse(
      "CONFLICT",
      "Reward projection does not match its committed financial receipt",
    );
  }
  const notificationId = uuidv5(
    `${intent.id.toLowerCase()}:${financial.id.toLowerCase()}`,
    namespace,
  );
  await set(
    enqueueBackgroundJob$,
    {
      id: notificationId,
      kind: MARKETING_REWARD_PROJECTION_JOB_KIND,
      handlerVersion: 1,
      userId: financial.actorUserId,
      orgId: financial.orgId,
      input: {
        version: 1,
        environment: intent.environment,
        intentId: intent.id.toLowerCase(),
        receipt: financial,
      },
    },
    signal,
  );
  return {
    status: 200 as const,
    body: {
      version: 1 as const,
      environment: env("ENV"),
      intentId: intent.id,
      receiptId: financial.id,
      notificationId,
    },
  };
});

export const marketingRewardProjectionRoutes: readonly RouteEntry[] = [
  {
    route: marketingRewardProjectionContract.notify,
    handler: queueProjection$,
    requestBodyPolicy: {
      maxBytes: 64 * 1024,
      tooLargeMessage: "Reward projection is too large",
    },
  },
];
