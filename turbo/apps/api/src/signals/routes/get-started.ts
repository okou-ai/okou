import {
  cronGetStartedContract,
  getStartedContract,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, eq } from "drizzle-orm";
import { command } from "ccstate";
import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  awardCompletedGetStartedQuest,
  createGetStartedClaim,
  getStartedClaimResponse,
  getStartedRewardsEnabled,
  getStartedStatus,
  getStartedUtcDay,
} from "../services/get-started-rewards.service";
import {
  normalizeGetStartedPostUrl,
  processGetStartedClaims,
} from "../services/get-started-review.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const rewardsUnavailable = Object.freeze({
  status: 403 as const,
  body: {
    error: {
      code: "FORBIDDEN",
      message: "Get started rewards are not available for this organization",
    },
  },
});

const status$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await getStartedRewardsEnabled(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  if (!enabled) {
    return rewardsUnavailable;
  }
  const body = await getStartedStatus(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    isAdmin: auth.orgRole === "admin",
  });
  signal.throwIfAborted();
  return { status: 200 as const, body };
});

const checkin$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await getStartedRewardsEnabled(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  if (!enabled) {
    return rewardsUnavailable;
  }
  const claim = await set(writeDb$).transaction((tx) => {
    return awardCompletedGetStartedQuest(tx, {
      orgId: auth.orgId,
      userId: auth.userId,
      questKey: "checkin",
      sourceKey: getStartedUtcDay(nowDate()),
    });
  });
  signal.throwIfAborted();
  if (!claim) {
    throw new Error("Authorized check-in did not create a claim");
  }
  return { status: 200 as const, body: getStartedClaimResponse(claim) };
});

const shareBody$ = bodyResultOf(getStartedContract.submitShare);

const share$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await getStartedRewardsEnabled(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  signal.throwIfAborted();
  if (!enabled) {
    return rewardsUnavailable;
  }
  const body = await get(shareBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const post = normalizeGetStartedPostUrl(body.data.url);
  if (!post) {
    return badRequestMessage("Submit a valid public X post URL");
  }
  const claim = await set(writeDb$).transaction(async (tx) => {
    const [granted] = await tx
      .select()
      .from(getStartedClaims)
      .where(
        and(
          eq(getStartedClaims.beneficiaryUserId, auth.userId),
          eq(getStartedClaims.questKey, "share"),
          eq(getStartedClaims.status, "granted"),
        ),
      )
      .limit(1);
    if (granted) {
      return granted;
    }
    const pending = await createGetStartedClaim(tx, {
      orgId: auth.orgId,
      userId: auth.userId,
      questKey: "share",
      sourceKey: post.id,
      postUrl: post.url,
    });
    if (!pending || pending.status !== "pending") {
      return pending;
    }
    const [used] = await tx
      .select({ id: getStartedClaims.id })
      .from(getStartedClaims)
      .where(eq(getStartedClaims.rewardKey, `share:${post.id}`))
      .limit(1);
    if (!used) {
      return pending;
    }
    const [duplicate] = await tx
      .update(getStartedClaims)
      .set({
        status: "ineligible",
        reason: "already_redeemed",
        updatedAt: nowDate(),
      })
      .where(eq(getStartedClaims.id, pending.id))
      .returning();
    if (!duplicate) {
      throw new Error("Duplicate X claim disappeared");
    }
    return duplicate;
  });
  signal.throwIfAborted();
  if (!claim) {
    throw new Error("Authorized X submission did not create a claim");
  }
  return { status: 202 as const, body: getStartedClaimResponse(claim) };
});

const review$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!get(hasValidCronSecret$)) {
    return cronUnauthorized();
  }
  const processed = await processGetStartedClaims(
    set(writeDb$),
    {},
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
  {
    route: getStartedContract.submitShare,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      share$,
    ),
  },
  { route: cronGetStartedContract.process, handler: review$ },
];
