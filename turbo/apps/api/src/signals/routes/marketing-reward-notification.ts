import { marketingRewardNotificationContract } from "@okouai/api-contracts/contracts/marketing-reward-notification";
import { marketingRewardReceiptSchema } from "@okouai/api-contracts/contracts/marketing-reward-settlement";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { marketingRewardIntentIdentity } from "../../lib/marketing-reward-intent-identity";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { tapError } from "../utils";
import type { RouteEntry } from "../route-entry";
import { enqueueBackgroundJob$ } from "../services/background-job-command.service";
import { resolveMarketingRewardIntent$ } from "../services/marketing-reward-settlement.service";
import { marketingRewardReceipt } from "../services/marketing-reward-receipt";
import {
  deliverMarketingRewardProjection$,
  MARKETING_REWARD_PROJECTION_JOB_KIND,
} from "../services/marketing-reward-projection.service";
import type { SchemaOutput } from "@okouai/api-contracts/contracts/trpc-contract";

import { db$ } from "../external/db";
import { marketingRewardSourceEventSchema } from "../../lib/marketing-reward-events";
import { MARKETING_REWARD_EVENT_JOB_KIND } from "../services/marketing-reward-event-publication";

const namespace = "d3f5d0e4-76eb-45b5-a34e-620b5804297b";
const log = logger("MarketingRewardNotification");
const body$ = bodyResultOf(marketingRewardNotificationContract.notify);

const progressNamespace = "942d923e-95b3-45ab-b833-ac4cedb8779c";
const target$ = computed(async (get) => {
  const body = await get(body$);
  if (!body.ok || body.data.kind !== "progress") {
    throw new Error("Expected a progress notification request");
  }
  if (body.data.environment !== env("ENV")) {
    return {
      kind: "error" as const,
      response: createErrorResponse(
        "CONFLICT",
        "Progress source environment mismatch",
      ),
    };
  }
  const source = body.data.source;
  if (source.kind === "event") {
    const [job] = await get(db$)
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.id, source.eventId),
          eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND),
        ),
      )
      .limit(1);
    if (!job) {
      return {
        kind: "error" as const,
        response: createErrorResponse(
          "NOT_FOUND",
          "Progress source proof not found",
        ),
      };
    }
    const event = marketingRewardSourceEventSchema.parse(job.input);
    if (
      event.id !== job.id ||
      event.orgId !== job.orgId ||
      event.userId !== job.userId ||
      event.version !== job.handlerVersion ||
      event.environment !== env("ENV")
    ) {
      throw new Error("Progress source proof has different durable ownership");
    }
    if (
      event.type !== "workflow.input-queued" &&
      event.type !== "workflow.run-created" &&
      event.type !== "invitation.attributed" &&
      event.type !== "invitation.revoked" &&
      event.type !== "invitation.accepted"
    ) {
      return {
        kind: "error" as const,
        response: createErrorResponse(
          "CONFLICT",
          "Source does not describe reward progress",
        ),
      };
    }
    return {
      kind: "target" as const,
      source: { kind: "event" as const, eventId: event.id },
      target: {
        actorUserId: event.userId,
        beneficiaryUserId:
          event.version === 3 ? event.userId : event.creatorUserId,
        orgId: event.orgId,
        rewardTarget: "user" as const,
      },
    };
  }
  const [claim] = await get(db$)
    .select({
      id: getStartedClaims.id,
      orgId: getStartedClaims.orgId,
      actorUserId: getStartedClaims.actorUserId,
      beneficiaryUserId: getStartedClaims.beneficiaryUserId,
      invitationId: getStartedClaims.invitationId,
      rewardTarget: getStartedClaims.rewardTarget,
    })
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.id, source.claimId),
        eq(getStartedClaims.questKey, "invite"),
      ),
    )
    .limit(1);
  if (!claim) {
    return {
      kind: "error" as const,
      response: createErrorResponse(
        "NOT_FOUND",
        "Progress invitation claim not found",
      ),
    };
  }
  if (!claim.beneficiaryUserId || claim.rewardTarget !== "user") {
    throw new Error("Progress claim has no original personal beneficiary");
  }
  if (claim.invitationId !== source.invitationId) {
    return {
      kind: "error" as const,
      response: createErrorResponse(
        "CONFLICT",
        "Progress invitation reference mismatch",
      ),
    };
  }
  return {
    kind: "target" as const,
    source: {
      kind: "invitation-claim" as const,
      claimId: claim.id,
      invitationId: source.invitationId,
    },
    target: {
      actorUserId: claim.actorUserId,
      beneficiaryUserId: claim.beneficiaryUserId,
      orgId: claim.orgId,
      rewardTarget: "user" as const,
    },
  };
});

const queueMarketingRewardProgress$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const result = await get(target$);
    signal.throwIfAborted();
    if (result.kind === "error") {
      return result.response;
    }
    // Deduplicate by immutable source, never an observation clock or caller-chosen recipient.
    const notificationId = uuidv5(
      JSON.stringify([env("ENV"), result.source]),
      progressNamespace,
    );
    await set(
      enqueueBackgroundJob$,
      {
        id: notificationId,
        kind: MARKETING_REWARD_PROJECTION_JOB_KIND,
        handlerVersion: 2,
        userId: result.target.actorUserId,
        orgId: result.target.orgId,
        input: {
          version: 2,
          environment: env("ENV"),
          source: result.source,
          target: result.target,
        },
      },
      signal,
    );
    return {
      status: 200 as const,
      body: {
        version: 1 as const,
        environment: env("ENV"),
        source: result.source,
        notificationId,
      },
    };
  },
);

type SettlementNotification = Extract<
  SchemaOutput<typeof marketingRewardNotificationContract.notify.body>,
  { kind: "settlement" }
>;

const queueSettlementNotification$ = command(
  async (
    { set },
    { intent, receipt }: SettlementNotification,
    signal: AbortSignal,
  ) => {
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
  },
);

const queueNotification$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "no-store");
    const secret = env("MARKETING_REWARDS_PROJECTION_SECRET");
    if (!secret) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Reward notification is not configured",
          },
        },
      };
    }
    const actual = Buffer.from(get(authorization$) ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      return createErrorResponse(
        "UNAUTHORIZED",
        "Invalid reward notification credential",
      );
    }
    const body = await get(body$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const result =
      body.data.kind === "progress"
        ? await set(queueMarketingRewardProgress$, signal)
        : await set(queueSettlementNotification$, body.data, signal);
    signal.throwIfAborted();
    if (result.status !== 200) {
      return result;
    }
    const notificationId = result.body.notificationId;
    waitUntil(
      tapError(
        set(
          deliverMarketingRewardProjection$,
          {
            jobId: notificationId,
            handlerVersion: body.data.kind === "progress" ? 2 : 1,
          },
          signal,
        ),
        (error) => {
          log.warn("Reward notification delivery will recover in background", {
            notificationId,
            error,
          });
        },
      ),
    );
    return result;
  },
);

export const marketingRewardNotificationRoutes: readonly RouteEntry[] = [
  {
    route: marketingRewardNotificationContract.notify,
    handler: queueNotification$,
    requestBodyPolicy: {
      maxBytes: 64 * 1024,
      tooLargeMessage: "Reward notification is too large",
    },
  },
];
