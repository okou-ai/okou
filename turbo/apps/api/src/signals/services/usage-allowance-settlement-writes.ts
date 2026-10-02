import { orgUsageAllowanceWindows } from "@okouai/db/schema/org-usage-allowance";
import { and, eq, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  allowanceConsumptionSql,
  insertAllocationsSql,
  type planAllowanceWrites,
} from "./usage-allowance-settlement-plan";

type PreparedAllowance = ReturnType<typeof planAllowanceWrites>;
type WindowIdentity = Pick<
  typeof orgUsageAllowanceWindows.$inferSelect,
  "id" | "entitlementId" | "kind" | "startsAt"
>;

function identity(window: WindowIdentity) {
  return `${window.entitlementId}/${window.kind}/${window.startsAt.toISOString()}`;
}

/** Resolve concurrent window creation by its business key, not its proposed UUID. */
export function issuedAllowanceWindowsQuery(plan: PreparedAllowance) {
  return new QueryBuilder()
    .select({
      id: orgUsageAllowanceWindows.id,
      entitlementId: orgUsageAllowanceWindows.entitlementId,
      kind: orgUsageAllowanceWindows.kind,
      startsAt: orgUsageAllowanceWindows.startsAt,
    })
    .from(orgUsageAllowanceWindows)
    .where(
      or(
        ...plan.inserted.map((window) => {
          return and(
            eq(orgUsageAllowanceWindows.entitlementId, window.entitlementId),
            eq(orgUsageAllowanceWindows.kind, window.kind),
            eq(orgUsageAllowanceWindows.startsAt, window.startsAt),
          );
        }),
      ) ?? sql`false`,
    )
    .as("issued_allowance_windows");
}

export function allowanceSettlementWrites(
  plan: PreparedAllowance,
  windows: readonly WindowIdentity[],
) {
  const actual = new Map(
    windows.map((window) => {
      return [identity(window), window.id];
    }),
  );
  const ids = new Map<string, string>();
  for (const window of plan.inserted) {
    const id = actual.get(identity(window));
    if (!id) {
      throw new Error("Issued usage allowance window is missing");
    }
    ids.set(window.id, id);
  }
  // Existing windows retain their IDs; only proposed IDs need resolution.
  const changes = plan.changes.map((change) => {
    return {
      ...change,
      id: ids.get(change.id) ?? change.id,
    };
  });
  const allocations = plan.allocations.map((allocation) => {
    return {
      ...allocation,
      shortWindowId:
        ids.get(allocation.shortWindowId) ?? allocation.shortWindowId,
      weeklyWindowId:
        ids.get(allocation.weeklyWindowId) ?? allocation.weeklyWindowId,
    };
  });
  return [
    {
      kind: "consumption",
      sql: allowanceConsumptionSql(changes, plan.at),
      planned: changes.length,
    },
    {
      kind: "allocation",
      sql: insertAllocationsSql(plan.orgId, allocations),
      planned: allocations.length,
    },
  ];
}
