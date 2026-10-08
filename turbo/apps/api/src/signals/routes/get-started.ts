import {
  cronGetStartedContract,
  getStartedContract,
} from "@okouai/api-contracts/contracts/get-started";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  completedGetStartedQuestSql,
  unresolvedClaimWhere,
} from "../services/get-started-member-reward";
import {
  normalizeGetStartedPostUrl,
  processGetStartedClaims$,
} from "../services/get-started-review.service";
import {
  createGetStartedClaim$,
  getStartedClaimResponse,
  getStartedStatus$,
  getStartedUtcDay,
} from "../services/get-started-rewards.service";
import { ensureGetStartedRewardWallet$ } from "../services/get-started-wallet.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
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

const checkin$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  await set(ensureGetStartedRewardWallet$, auth.orgId, signal);
  const db = set(writeDb$);
  const at = nowDate();
  const sourceKey = getStartedUtcDay(at);
  // Claim identity and credit publication are one statement; duplicate callers
  // observe the winner without an outer wallet transaction.
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
    throw new Error("Get started check-in was not persisted");
  }
  return { status: 200 as const, body: getStartedClaimResponse(current) };
});

const shareBody$ = bodyResultOf(getStartedContract.submitShare);
const share$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(shareBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const post = normalizeGetStartedPostUrl(body.data.url);
  if (!post) {
    return badRequestMessage("Submit a valid public X post URL");
  }
  const db = set(writeDb$);
  const [granted] = await db
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
  signal.throwIfAborted();
  if (granted) {
    return { status: 202 as const, body: getStartedClaimResponse(granted) };
  }
  const pending = await set(
    createGetStartedClaim$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      questKey: "share",
      sourceKey: post.id,
      postUrl: post.url,
    },
    signal,
  );
  if (pending.status !== "pending") {
    return { status: 202 as const, body: getStartedClaimResponse(pending) };
  }
  // Historical grants used post identities rather than author identities.
  const [used] = await db
    .select({ id: getStartedClaims.id })
    .from(getStartedClaims)
    .where(eq(getStartedClaims.rewardKey, `share:${post.id}`))
    .limit(1);
  signal.throwIfAborted();
  if (!used) {
    return { status: 202 as const, body: getStartedClaimResponse(pending) };
  }
  const [duplicate] = await db
    .update(getStartedClaims)
    .set({
      status: "ineligible",
      reason: "already_redeemed",
      updatedAt: nowDate(),
    })
    .where(
      and(
        unresolvedClaimWhere(pending),
        eq(getStartedClaims.status, "pending"),
      ),
    )
    .returning();
  signal.throwIfAborted();
  if (duplicate) {
    return { status: 202 as const, body: getStartedClaimResponse(duplicate) };
  }
  // A reviewer acquired or resolved the claim; serialize its current result.
  const [current] = await db
    .select()
    .from(getStartedClaims)
    .where(eq(getStartedClaims.id, pending.id));
  signal.throwIfAborted();
  if (!current) {
    throw new Error("Duplicate X claim disappeared");
  }
  return { status: 202 as const, body: getStartedClaimResponse(current) };
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
  {
    route: getStartedContract.submitShare,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      share$,
    ),
  },
  { route: cronGetStartedContract.process, handler: review$ },
];
