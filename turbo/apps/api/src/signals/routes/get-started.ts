import { waitUntil } from "../context/wait-until";
import { deliverMarketingRewardEvents$ } from "../services/marketing-reward-event-delivery.service";
import {
  cronGetStartedContract,
  getStartedContract,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { completedGetStartedQuestSql } from "../services/get-started-member-reward";
import { processGetStartedClaims$ } from "../services/get-started-review.service";
import {
  getStartedClaimResponse,
  getStartedStatus$,
  getStartedUtcDay,
} from "../services/get-started-rewards.service";
import { ensureGetStartedRewardWallet$ } from "../services/get-started-wallet.service";
import { requestMarketingRewardCheckin$ } from "../services/marketing-reward-checkin.service";
import { getStartedRewardWriter } from "../services/marketing-reward-ownership";
import {
  marketingRewardCampaignConfigured,
  readMarketingRewardStatus,
  requestMarketingCheckin,
} from "../external/marketing-reward-campaign";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { settle } from "../utils";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (
    getStartedRewardWriter("user", auth.userId) === "marketing" ||
    getStartedRewardWriter("org", auth.orgId) === "marketing"
  ) {
    const result = await settle(
      readMarketingRewardStatus(
        {
          userId: auth.userId,
          orgId: auth.orgId,
          admin: auth.orgRole === "admin",
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return unavailable();
    }
    return { status: 200 as const, body: result.value };
  }
  const body = await set(
    getStartedStatus$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      isAdmin: auth.orgRole === "admin",
    },
    signal,
  );
  return { status: 200 as const, body };
});

function unavailable() {
  return {
    status: 503 as const,
    body: {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Rewards are temporarily unavailable",
      },
    },
  };
}

const checkin$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  await set(ensureGetStartedRewardWallet$, auth.orgId, signal);
  const db = set(writeDb$);
  const at = nowDate();
  const sourceKey = getStartedUtcDay(at);
  const request = await set(
    requestMarketingRewardCheckin$,
    { orgId: auth.orgId, userId: auth.userId, requestedAt: at },
    signal,
  );
  waitUntil(
    set(
      deliverMarketingRewardEvents$,
      { jobId: request.id, handlerVersion: 5 },
      signal,
    ),
  );
  const writer = getStartedRewardWriter("user", auth.userId);
  if (writer === "marketing") {
    if (!marketingRewardCampaignConfigured()) {
      return unavailable();
    }
    // A lost response can follow a committed grant. The saved request and
    // existing outbox recover it; no legacy financial fallback is attempted.
    await settle(requestMarketingCheckin(request, signal));
    signal.throwIfAborted();
  }
  // Claim identity and credit publication are one statement; duplicate callers
  // observe the winner without an outer wallet transaction.
  if (writer === "app") {
    await db.execute(
      completedGetStartedQuestSql(
        {
          orgId: auth.orgId,
          userId: auth.userId,
          questKey: "checkin",
          sourceKey,
        },
        at,
      ),
    );
  }
  signal.throwIfAborted();
  const [current] = await db
    .select()
    .from(getStartedClaims)
    .where(
      and(
        eq(getStartedClaims.actorUserId, auth.userId),
        eq(getStartedClaims.questKey, "checkin"),
        eq(getStartedClaims.sourceKey, sourceKey),
      ),
    );
  signal.throwIfAborted();
  if (!current) {
    if (writer === "marketing") {
      return {
        status: 202 as const,
        body: { status: "pending" as const, requestId: request.id },
      };
    }
    throw new Error("Get started check-in was not persisted");
  }
  if (
    writer === "marketing" &&
    (current.status === "pending" || current.status === "reviewing")
  ) {
    return {
      status: 202 as const,
      body: { status: "pending" as const, requestId: request.id },
    };
  }
  if (current.status !== "granted") {
    return createErrorResponse(
      "CONFLICT",
      "This check-in is not eligible for credits",
    );
  }
  return { status: 200 as const, body: getStartedClaimResponse(current) };
});

const review$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const processed = await set(
    processGetStartedClaims$,
    AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { processed } };
});

export const getStartedRoutes: readonly RouteEntry[] = [
  {
    route: getStartedContract.status,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      status$,
    ),
  },
  {
    route: getStartedContract.checkin,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkin$,
    ),
  },
  { route: cronGetStartedContract.process, handler: review$ },
];
