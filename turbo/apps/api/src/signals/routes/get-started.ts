import { waitUntil } from "../context/wait-until";
import { deliverMarketingRewardEvents$ } from "../services/marketing-reward-event-delivery.service";
import { getStartedContract } from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  getStartedClaimResponse,
  getStartedUtcDay,
} from "../services/get-started-rewards.service";
import { ensureGetStartedRewardWallet$ } from "../services/get-started-wallet.service";
import { requestMarketingRewardCheckin$ } from "../services/marketing-reward-checkin.service";
import {
  marketingRewardCampaignConfigured,
  readMarketingRewardStatus,
  requestMarketingCheckin,
} from "../external/marketing-reward-campaign";
import { createErrorResponse } from "@okouai/api-contracts/contracts/errors";
import { settle } from "../utils";

const status$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!marketingRewardCampaignConfigured()) {
    return createErrorResponse(
      "NOT_FOUND",
      "Get started rewards are not configured",
    );
  }
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
  return result.ok
    ? { status: 200 as const, body: result.value }
    : unavailable();
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
  if (!marketingRewardCampaignConfigured()) {
    return unavailable();
  }
  // A lost response can follow a committed grant. Recover the original request
  // through the source outbox and financial receipt without funding it locally.
  await settle(requestMarketingCheckin(request, signal));
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
    return {
      status: 202 as const,
      body: { status: "pending" as const, requestId: request.id },
    };
  }
  if (current.status === "pending" || current.status === "reviewing") {
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
];
