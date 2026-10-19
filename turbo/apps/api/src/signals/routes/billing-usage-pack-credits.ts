import { command } from "ccstate";
import { desc } from "drizzle-orm";
import { usagePackAllocations } from "@okouai/db/schema/usage-pack-subscription";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { nowDate } from "../../lib/time";
import { billingUsagePackCreditsContract } from "@okouai/api-contracts/contracts/billing";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import {
  activeUsagePackAllocationReadPlan,
  usagePackCreditBalanceReadPlan,
  usagePackCreditBalanceFromRows,
  organizationUsagePackCreditBalancesReadPlan,
  organizationUsagePackCreditBalancesFromRows,
} from "../services/usage-pack-credit.service";
import type { RouteEntry } from "../route-entry";

const getUsagePackCredits$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  const allocationArgs = {
    orgId: auth.orgId,
    ...(auth.orgRole === "admin" ? {} : { userId: auth.userId }),
  };
  const hasUsagePack = await (async () => {
    const plan = activeUsagePackAllocationReadPlan(allocationArgs);
    const [allocation] = await db
      .select(plan.columns)
      .from(usagePackAllocations)
      .where(plan.condition)
      .limit(1);
    return allocation !== undefined;
  })();
  signal.throwIfAborted();
  const balanceArgs = { orgId: auth.orgId, userId: auth.userId };
  const body = await (async () => {
    const at = nowDate();
    const plan = usagePackCreditBalanceReadPlan({ ...balanceArgs, at });
    const rows = await db
      .select(plan.columns)
      .from(usagePackCreditGrants)
      .where(plan.condition)
      .orderBy(desc(usagePackCreditGrants.createdAt));
    return usagePackCreditBalanceFromRows(rows);
  })();
  signal.throwIfAborted();
  if (auth.orgRole === "admin") {
    const organizationBalanceArgs = { orgId: auth.orgId };
    const memberCredits = await (async () => {
      const at = nowDate();
      const plan = organizationUsagePackCreditBalancesReadPlan({
        ...organizationBalanceArgs,
        at,
      });
      const rows = await db
        .select(plan.columns)
        .from(usagePackCreditGrants)
        .where(plan.condition)
        .orderBy(
          usagePackCreditGrants.userId,
          desc(usagePackCreditGrants.createdAt),
        );
      return organizationUsagePackCreditBalancesFromRows(rows);
    })();
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { ...body, hasUsagePack, memberCredits },
    };
  }
  return { status: 200 as const, body: { ...body, hasUsagePack } };
});

export const billingUsagePackCreditsRoutes: readonly RouteEntry[] = [
  {
    route: billingUsagePackCreditsContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUsagePackCredits$,
    ),
  },
];
