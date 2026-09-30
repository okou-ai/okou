import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { command } from "ccstate";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import {
  currentAllowanceEntitlement,
  type AllowanceAvailability,
} from "./usage-allowance-availability-plan";
import {
  entitlementQuery,
  planPreparedAllowanceEntitlement,
  type AllowanceEntitlement,
} from "./usage-allowance-settlement-plan";
import {
  orgCreditCompatibilityLockSql,
  prepareUsageAllowanceRefresh$,
} from "./usage-allowance.service";

function runWindowsQuery(
  orgId: string,
  at: Date,
  entitlement?: AllowanceEntitlement,
) {
  const selected = sql`SELECT chosen.id
    FROM (VALUES ('short'), ('weekly')) AS kinds(kind)
    CROSS JOIN LATERAL (
      SELECT ${orgUsageAllowanceWindows.id} AS id
      FROM ${orgUsageAllowanceWindows}
      WHERE ${and(
        eq(orgUsageAllowanceWindows.orgId, orgId),
        eq(orgUsageAllowanceWindows.kind, sql`kinds.kind`),
        lte(orgUsageAllowanceWindows.startsAt, at),
        gt(orgUsageAllowanceWindows.expiresAt, at),
        entitlement
          ? and(
              eq(orgUsageAllowanceWindows.entitlementId, entitlement.id),
              gte(orgUsageAllowanceWindows.startsAt, entitlement.effectiveAt),
            )
          : undefined,
      )}
      ORDER BY ${orgUsageAllowanceWindows.startsAt} DESC, ${orgUsageAllowanceWindows.id} ASC LIMIT 1
    ) AS chosen`;
  return new QueryBuilder()
    .select({
      id: orgUsageAllowanceWindows.id,
      kind: orgUsageAllowanceWindows.kind,
      unitLimit: orgUsageAllowanceWindows.unitLimit,
      consumedUnits: orgUsageAllowanceWindows.consumedUnits,
    })
    .from(orgUsageAllowanceWindows)
    .where(sql`${orgUsageAllowanceWindows.id} IN (${selected})`)
    .orderBy(
      sql`CASE WHEN ${orgUsageAllowanceWindows.kind} = 'short' THEN 0 ELSE 1 END`,
      asc(orgUsageAllowanceWindows.id),
    )
    .as("run_allowance_windows");
}

function runWindowAvailability(
  windows: readonly {
    readonly kind: string;
    readonly unitLimit: number;
    readonly consumedUnits: number;
  }[],
): AllowanceAvailability | null {
  const short = windows.find((window) => {
    return window.kind === "short";
  });
  const weekly = windows.find((window) => {
    return window.kind === "weekly";
  });
  if (!short || !weekly) {
    return null;
  }
  const shortRemainingUnits = Math.max(
    short.unitLimit - short.consumedUnits,
    0,
  );
  const weeklyRemainingUnits = Math.max(
    weekly.unitLimit - weekly.consumedUnits,
    0,
  );
  return {
    shortRemainingUnits,
    weeklyRemainingUnits,
    remainingUnits: Math.min(shortRemainingUnits, weeklyRemainingUnits),
  };
}

function unchangedEntitlement(owned: {
  readonly id: string;
  readonly snapshot: string;
}) {
  return and(
    eq(orgUsageAllowanceEntitlements.id, owned.id),
    sql`${orgUsageAllowanceEntitlements}::text = ${owned.snapshot}`,
  );
}

function requireRefreshPublication(
  published: { readonly id: string } | undefined,
) {
  if (!published) {
    throw new Error("Run allowance changed during refresh publication");
  }
}

/** Issued Run windows remain usable after their entitlement's current period. */
export const resolveUsageAllowanceAvailabilityForRun$ = command(
  async (
    { set },
    args: { readonly orgId: string; readonly runId: string },
    signal?: AbortSignal,
  ): Promise<AllowanceAvailability | null> => {
    const db = set(writeDb$);
    const runCondition = and(
      eq(agentRuns.orgId, args.orgId),
      eq(agentRuns.id, args.runId),
    );
    const [observedRun] = await db
      .select({ createdAt: agentRuns.createdAt })
      .from(agentRuns)
      .where(runCondition)
      .limit(1);
    signal?.throwIfAborted();
    if (!observedRun) {
      return null;
    }
    const observedWindows = await db
      .select()
      .from(runWindowsQuery(args.orgId, observedRun.createdAt));
    signal?.throwIfAborted();
    const refresh = runWindowAvailability(observedWindows)
      ? undefined
      : await set(prepareUsageAllowanceRefresh$, { orgId: args.orgId }, signal);
    signal?.throwIfAborted();
    const outcome = await settle(
      db.transaction(async (tx) => {
        await tx.execute(orgCreditCompatibilityLockSql(args.orgId));
        const [run] = await tx
          .select({ createdAt: agentRuns.createdAt })
          .from(agentRuns)
          .where(runCondition)
          .limit(1);
        signal?.throwIfAborted();
        if (!run) {
          return null;
        }
        const [owned] = await tx.select().from(entitlementQuery(args.orgId));
        signal?.throwIfAborted();
        const issued = runWindowAvailability(
          await tx.select().from(runWindowsQuery(args.orgId, run.createdAt)),
        );
        signal?.throwIfAborted();
        if (issued) {
          return issued;
        }
        const at = nowDate();
        const prepared = planPreparedAllowanceEntitlement(
          currentAllowanceEntitlement(owned, at),
          refresh,
          at,
        );
        if (prepared.update && owned) {
          const [published] = await tx
            .update(orgUsageAllowanceEntitlements)
            .set(prepared.update)
            .where(unchangedEntitlement(owned))
            .returning({ id: orgUsageAllowanceEntitlements.id });
          signal?.throwIfAborted();
          requireRefreshPublication(published);
        }
        const entitlement = prepared.entitlement;
        if (
          !entitlement ||
          entitlement.effectiveAt > run.createdAt ||
          (entitlement.expiresAt && entitlement.expiresAt <= run.createdAt)
        ) {
          return null;
        }
        const windows = await tx
          .select()
          .from(runWindowsQuery(args.orgId, run.createdAt, entitlement));
        signal?.throwIfAborted();
        for (const kind of ["short", "weekly"] as const) {
          if (
            windows.some((window) => {
              return window.kind === kind;
            })
          ) {
            continue;
          }
          const [window] = await tx
            .insert(orgUsageAllowanceWindows)
            .values({
              orgId: args.orgId,
              entitlementId: entitlement.id,
              kind,
              startsAt: run.createdAt,
              expiresAt: new Date(
                run.createdAt.getTime() +
                  1000 *
                    (kind === "short"
                      ? entitlement.shortWindowSeconds
                      : entitlement.weeklyWindowSeconds),
              ),
              unitLimit:
                kind === "short"
                  ? entitlement.shortWindowUnits
                  : entitlement.weeklyWindowUnits,
              consumedUnits: 0,
              createdByRunId: args.runId,
            })
            .returning({
              id: orgUsageAllowanceWindows.id,
              kind: orgUsageAllowanceWindows.kind,
              unitLimit: orgUsageAllowanceWindows.unitLimit,
              consumedUnits: orgUsageAllowanceWindows.consumedUnits,
            });
          signal?.throwIfAborted();
          if (!window) {
            throw new Error("Usage allowance window insert returned no row");
          }
          windows.push(window);
        }
        return runWindowAvailability(windows);
      }),
      signal,
    );
    if (outcome.ok) {
      return outcome.value;
    }
    // The entitlement row is owned above, so the only FK a window insert can
    // lose is created_by_run_id: the Run was deleted after our read. A deleted
    // Run has no allowance, the same result as a Run that was never found.
    if (isForeignKeyViolation(outcome.error)) {
      return null;
    }
    throw outcome.error;
  },
);
