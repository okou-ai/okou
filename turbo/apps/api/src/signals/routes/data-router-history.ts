import { dataRouterHistoryContract } from "@okouai/api-contracts/contracts/data-router";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { dataRouterRequests } from "@okouai/db/schema/data-router-request";
import { command } from "ccstate";
import { and, desc, eq } from "drizzle-orm";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";

const list$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const db = get(db$);
  signal.throwIfAborted();
  const rows = await db
    .select({ requestId: dataRouterRequests.requestId })
    .from(dataRouterRequests)
    .innerJoin(
      billingRunAttribution,
      eq(billingRunAttribution.runId, dataRouterRequests.runId),
    )
    .where(
      and(
        eq(billingRunAttribution.orgId, auth.orgId),
        eq(billingRunAttribution.userId, auth.userId),
      ),
    )
    .orderBy(desc(dataRouterRequests.createdAt))
    .limit(1000);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: {
      requestIds: rows.map((row) => {
        return row.requestId;
      }),
    },
  };
});

export const dataRouterHistoryRoutes: readonly RouteEntry[] = [
  {
    route: dataRouterHistoryContract.list,
    handler: authRoute({ requireOrganization: true }, list$),
  },
];
