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
