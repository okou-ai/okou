import { marketingRewardProjectionContract } from "@okouai/api-contracts/contracts/marketing-reward-projection";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { marketingRewardSourceEventSchema } from "../../lib/marketing-reward-events";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { enqueueBackgroundJob$ } from "../services/background-job-command.service";
import { MARKETING_REWARD_EVENT_JOB_KIND } from "../services/marketing-reward-event-publication";
import {
  deliverMarketingRewardProjection$,
  MARKETING_REWARD_PROJECTION_JOB_KIND,
} from "../services/marketing-reward-projection.service";
import { tapError } from "../utils";

const log = logger("MarketingRewardProgress");
const namespace = "942d923e-95b3-45ab-b833-ac4cedb8779c";
const body$ = bodyResultOf(marketingRewardProjectionContract.notifyProgress);
const target$ = computed(async (get) => {
  const body = await get(body$);
  if (!body.ok) {
    return { kind: "error" as const, response: body.response };
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

const queueProgress$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_PROJECTION_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Reward progress refresh is not configured",
        },
      },
    };
  }
  const actual = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Invalid reward progress credential",
    );
  }
  const result = await get(target$);
  signal.throwIfAborted();
  if (result.kind === "error") {
    return result.response;
  }
  // Deduplicate by immutable source, never an observation clock or caller-chosen recipient.
  const notificationId = uuidv5(
    JSON.stringify([env("ENV"), result.source]),
    namespace,
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
  waitUntil(
    tapError(
      set(
        deliverMarketingRewardProjection$,
        { jobId: notificationId, handlerVersion: 2 },
        signal,
      ),
      (error) => {
        log.warn("Reward progress delivery will recover in background", {
          notificationId,
          error,
        });
      },
    ),
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
});

export const marketingRewardProgressRoute: RouteEntry = Object.freeze({
  route: marketingRewardProjectionContract.notifyProgress,
  handler: queueProgress$,
  requestBodyPolicy: {
    maxBytes: 4096,
    tooLargeMessage: "Reward progress source is too large",
  },
});
