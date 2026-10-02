import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  orgUsageAllowanceEntitlements,
  orgUsageAllowanceWindows,
} from "@okouai/db/schema/org-usage-allowance";
import { and, asc, eq, gt, gte, lte, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { currentAllowanceEntitlement } from "./usage-allowance-availability-plan";
import {
  planPreparedAllowanceEntitlement,
  type AllowanceEntitlement,
} from "./usage-allowance-settlement-plan";
import type { PreparedUsageAllowanceRefresh } from "./usage-allowance.service";

export function requireRunAllowanceWindowPair(
  windows: readonly { readonly kind: string }[],
) {
  if (
    !windows.some((window) => {
      return window.kind === "short";
    }) ||
    !windows.some((window) => {
      return window.kind === "weekly";
    })
  ) {
    throw new Error("Run allowance changed during window publication");
  }
}

/** Pure builders for SQL owned by admission and Run-availability commands. */
export function runAllowanceWindowsQuery(
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

export function unchangedRunAllowanceEntitlement(owned: {
  readonly id: string;
  readonly snapshot: string;
}) {
  return and(
    eq(orgUsageAllowanceEntitlements.id, owned.id),
    eq(sql`${orgUsageAllowanceEntitlements}::text`, owned.snapshot),
  );
}

export interface RunAllowanceActivationInput {
  readonly orgId: string;
  readonly runId: string;
  readonly runCreatedAt: Date;
  readonly refresh?: PreparedUsageAllowanceRefresh;
}

/** Refresh preparation is external; the caller publishes this plan with CAS. */
export function planRunAllowanceActivation(
  owned: AllowanceEntitlement | undefined,
  args: RunAllowanceActivationInput,
  at: Date,
) {
  if (owned && owned.orgId !== args.orgId) {
    throw new Error(
      "Run allowance entitlement belongs to another organization",
    );
  }
  const prepared = planPreparedAllowanceEntitlement(
    currentAllowanceEntitlement(owned, at),
    args.refresh,
    at,
  );
  const entitlement = prepared.entitlement;
  return {
    update: prepared.update,
    entitlement:
      entitlement &&
      entitlement.effectiveAt <= args.runCreatedAt &&
      (!entitlement.expiresAt || args.runCreatedAt < entitlement.expiresAt)
        ? entitlement
        : null,
  };
}

/**
 * Publish both missing kinds in one statement. No balance is reserved or reset.
 * The exact entitlement snapshot and tenant-owned Run gate every inserted row.
 * The caller reads the canonical covering identities once after conflicts.
 */
export function runAllowanceWindowInsertSql(
  args: Omit<RunAllowanceActivationInput, "refresh">,
  entitlement: AllowanceEntitlement,
) {
  if (args.orgId !== entitlement.orgId) {
    throw new Error(
      "Run allowance entitlement belongs to another organization",
    );
  }
  const at = sql`${sql.param(args.runCreatedAt, orgUsageAllowanceWindows.startsAt)}::timestamp`;
  return sql`INSERT INTO ${orgUsageAllowanceWindows}
    (org_id, entitlement_id, kind, starts_at, expires_at, unit_limit, consumed_units, created_by_run_id)
    SELECT ${orgUsageAllowanceEntitlements.orgId}, ${orgUsageAllowanceEntitlements.id}, kinds.kind,
      ${at}, ${at} + make_interval(secs => CASE WHEN kinds.kind = 'short'
        THEN ${orgUsageAllowanceEntitlements.shortWindowSeconds}
        ELSE ${orgUsageAllowanceEntitlements.weeklyWindowSeconds} END),
      CASE WHEN kinds.kind = 'short' THEN ${orgUsageAllowanceEntitlements.shortWindowUnits}
        ELSE ${orgUsageAllowanceEntitlements.weeklyWindowUnits} END,
      0, ${args.runId}::uuid
    FROM ${orgUsageAllowanceEntitlements}
    CROSS JOIN (VALUES ('short'), ('weekly')) AS kinds(kind)
    WHERE ${unchangedRunAllowanceEntitlement(entitlement)}
      AND ${eq(orgUsageAllowanceEntitlements.orgId, args.orgId)}
      AND EXISTS (SELECT 1 FROM ${agentRuns} WHERE ${and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.createdAt, args.runCreatedAt),
      )})
      AND NOT EXISTS (SELECT 1 FROM ${orgUsageAllowanceWindows} WHERE ${and(
        eq(orgUsageAllowanceWindows.orgId, args.orgId),
        eq(orgUsageAllowanceWindows.entitlementId, entitlement.id),
        eq(orgUsageAllowanceWindows.kind, sql`kinds.kind`),
        gte(orgUsageAllowanceWindows.startsAt, entitlement.effectiveAt),
        lte(orgUsageAllowanceWindows.startsAt, args.runCreatedAt),
        gt(orgUsageAllowanceWindows.expiresAt, args.runCreatedAt),
      )})
    ON CONFLICT (entitlement_id, kind, starts_at) DO NOTHING`;
}
