import { marketingInvitationSourceContract } from "@okouai/api-contracts/contracts/marketing-invitation-source";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { timingSafeEqual } from "node:crypto";
import { env } from "../../lib/env";
import { marketingRewardSourceEventSchema } from "../../lib/marketing-reward-events";
import { nowDate } from "../../lib/time";
import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import {
  clerkRateLimit,
  clerkReadUnavailable,
  readClerkInvitationAuthority,
} from "../external/clerk";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { settle } from "../utils";
import {
  MARKETING_REWARD_EVENT_JOB_KIND,
  MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION,
} from "../services/marketing-reward-event-publication";

const source$ = computed(async (get) => {
  const { eventId } = get(
    pathParamsOf(marketingInvitationSourceContract.observe),
  );
  const [job] = await get(db$)
    .select()
    .from(backgroundJobs)
    .where(
      and(
        eq(backgroundJobs.id, eventId),
        eq(backgroundJobs.kind, MARKETING_REWARD_EVENT_JOB_KIND),
        eq(
          backgroundJobs.handlerVersion,
          MARKETING_REWARD_INVITATION_EVENT_HANDLER_VERSION,
        ),
      ),
    )
    .limit(1);
  if (!job) {
    return null;
  }
  const event = marketingRewardSourceEventSchema.parse(job.input);
  if (event.version !== 3) {
    throw new Error("Invitation source proof has a different version");
  }
  if (
    job.id !== event.id ||
    job.orgId !== event.orgId ||
    job.userId !== event.userId ||
    event.environment !== env("ENV")
  ) {
    throw new Error("Invitation source proof does not match its durable owner");
  }
  return event.type === "invitation.attributed" ? event : null;
});

const observe$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const secret = env("MARKETING_REWARDS_SOURCE_SECRET");
  if (!secret) {
    return {
      status: 503 as const,
      body: {
        error: {
          code: "SERVICE_UNAVAILABLE",
          message: "Invitation source observation is not configured",
        },
      },
    };
  }
  const actual = Buffer.from(get(authorization$) ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return createErrorResponse(
      "UNAUTHORIZED",
      "Invalid invitation source credential",
    );
  }
  const source = await get(source$);
  signal.throwIfAborted();
  if (!source) {
    return createErrorResponse(
      "NOT_FOUND",
      "Invitation source proof not found",
    );
  }
  const read = await settle(
    readClerkInvitationAuthority(source.orgId, source.invitationId, signal),
  );
  signal.throwIfAborted();
  if (!read.ok) {
    if (clerkReadUnavailable(read.error) || clerkRateLimit(read.error)) {
      return {
        status: 503 as const,
        body: {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Invitation authority is temporarily unavailable",
          },
        },
      };
    }
    throw read.error;
  }
  const invitation = read.value;
  return {
    status: 200 as const,
    body: {
      version: 1 as const,
      environment: source.environment,
      observedAt: nowDate().toISOString(),
      source: {
        eventId: source.id,
        occurredAt: source.occurredAt,
        orgId: source.orgId,
        inviterUserId: source.userId,
        claimId: source.claimId,
        sourceKey: source.sourceKey,
        invitationId: source.invitationId,
      },
      observation: invitation
        ? { kind: "invitation" as const, ...invitation }
        : { kind: "unavailable" as const },
    },
  };
});

export const marketingInvitationSourceRoutes: readonly RouteEntry[] = [
  { route: marketingInvitationSourceContract.observe, handler: observe$ },
];
