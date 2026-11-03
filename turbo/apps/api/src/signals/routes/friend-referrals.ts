import { randomInt } from "node:crypto";
import {
  FRIEND_REFERRAL_REWARD_CREDITS,
  friendReferralsContract,
} from "@okouai/api-contracts/contracts/friend-referrals";
import {
  friendReferralLinks,
  friendReferrals,
} from "@okouai/db/schema/friend-referral";
import { and, count, eq } from "drizzle-orm";
import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import { notFound, resourceUnavailable } from "../../lib/error";
import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { friendReferralsEnabled$ } from "../services/friend-referrals.service";
import {
  friendReferralVisitToken,
  readFriendReferralVisit,
} from "../services/friend-referral-visit";

const link$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { orgId, userId } = get(organizationAuthContext$);
  if (!(await set(friendReferralsEnabled$, orgId, userId, signal))) {
    return resourceUnavailable("Friend referrals are not available");
  }
  const db = set(writeDb$);
  // Candidate rows share one owner: its unique key allows only one insert,
  // while a short-code collision skips to another candidate in the same SQL.
  const [created] = await db
    .insert(friendReferralLinks)
    .values(
      Array.from({ length: 8 }, () => {
        return {
          orgId,
          userId,
          code: randomInt(36 ** 6)
            .toString(36)
            .padStart(6, "0"),
        };
      }),
    )
    .onConflictDoNothing()
    .returning();
  signal.throwIfAborted();
  const [link] = created
    ? [created]
    : await db
        .select()
        .from(friendReferralLinks)
        .where(
          and(
            eq(friendReferralLinks.orgId, orgId),
            eq(friendReferralLinks.userId, userId),
          ),
        );
  signal.throwIfAborted();
  if (!link) {
    throw new Error("Friend referral link was not persisted");
  }
  const [totals] = await db
    .select({
      registeredCount: count(),
      rewardedCount: count(friendReferrals.grantedAt),
    })
    .from(friendReferrals)
    .where(eq(friendReferrals.linkId, link.id));
  signal.throwIfAborted();
  if (!totals) {
    throw new Error("Friend referral aggregate did not return a row");
  }
  const { registeredCount, rewardedCount } = totals;
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: {
      code: link.code,
      registeredCount,
      rewardedCount,
      earnedCredits: rewardedCount * FRIEND_REFERRAL_REWARD_CREDITS,
    },
  };
});

const visit$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(friendReferralsContract.visit));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const [link] = await set(writeDb$)
    .select()
    .from(friendReferralLinks)
    .where(eq(friendReferralLinks.code, body.data.code));
  signal.throwIfAborted();
  if (
    !link ||
    !(await set(friendReferralsEnabled$, link.orgId, link.userId, signal))
  ) {
    return notFound("Referral link is unavailable");
  }
  set(setResHeader$, "Cache-Control", "no-store");
  return {
    status: 200 as const,
    body: { token: friendReferralVisitToken(link.id, nowDate()) },
  };
});

const register$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { userId } = get(authContext$);
  const body = await get(bodyResultOf(friendReferralsContract.register));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const ineligible = {
    status: 200 as const,
    body: { status: "ineligible" as const },
  };
  const visit = readFriendReferralVisit(body.data.token, nowDate());
  if (!visit) {
    return ineligible;
  }
  const db = set(writeDb$);
  const [link] = await db
    .select()
    .from(friendReferralLinks)
    .where(eq(friendReferralLinks.id, visit.linkId));
  signal.throwIfAborted();
  if (
    !link ||
    link.userId === userId ||
    !(await set(friendReferralsEnabled$, link.orgId, link.userId, signal))
  ) {
    return ineligible;
  }
  const user = await get(clerk$).users.getUser(userId, undefined, signal);
  signal.throwIfAborted();
  if (
    user.createdAt === undefined ||
    user.createdAt < visit.visitedAt ||
    user.createdAt > nowDate().getTime() ||
    user.banned
  ) {
    return ineligible;
  }
  // The first accepted registration owns attribution across all future links
  // and workspaces. An authenticated browser cannot supply an account date.
  await db
    .insert(friendReferrals)
    .values({
      inviteeUserId: userId,
      linkId: link.id,
      registeredAt: new Date(user.createdAt),
    })
    .onConflictDoNothing({ target: friendReferrals.inviteeUserId });
  signal.throwIfAborted();
  set(setResHeader$, "Cache-Control", "no-store");
  return { status: 200 as const, body: { status: "registered" as const } };
});

export const friendReferralRoutes: readonly RouteEntry[] = [
  {
    route: friendReferralsContract.link,
    handler: authRoute(
      { requireOrganization: true, accept: ["session"] },
      link$,
    ),
  },
  { route: friendReferralsContract.visit, handler: visit$ },
  {
    route: friendReferralsContract.register,
    handler: authRoute({ accept: ["session"] }, register$),
  },
];
