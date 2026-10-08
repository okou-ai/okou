import { orgUsageAllowanceEntitlements } from "@okouai/db/schema/org-usage-allowance";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { pendingLaunchUpdateSql } from "./pending-launch-sql";
import type { AllowanceEntitlement } from "./usage-allowance-settlement-plan";
import {
  planRunAllowanceActivation,
  runAllowanceWindowInsertSql,
  runAllowanceWindowsQuery,
  unchangedRunAllowanceEntitlement,
  type RunAllowanceActivationInput,
} from "./usage-allowance-run-plan";

/** Non-executing CAS publication, using the exact captured entitlement row. */
export function pendingRunAllowancePlan(
  owned: AllowanceEntitlement | undefined,
  activation: RunAllowanceActivationInput,
  at: Date,
) {
  const planned = planRunAllowanceActivation(owned, activation, at);
  const builder = new QueryBuilder();
  const published =
    planned.update && owned
      ? builder.$with("published_pending_allowance", {
          snapshot: sql`${orgUsageAllowanceEntitlements}::text`
            .mapWith(pgTextDecoder)
            .as("snapshot"),
        })
          .as(sql`${pendingLaunchUpdateSql(orgUsageAllowanceEntitlements, planned.update, unchangedRunAllowanceEntitlement(owned))}
        RETURNING ${orgUsageAllowanceEntitlements}::text AS snapshot`)
      : undefined;
  return {
    entitlement: planned.entitlement,
    publication: published
      ? builder
          .with(published)
          .select({ snapshot: published.snapshot })
          .from(published)
          .getSQL()
      : undefined,
  };
}

export const allowanceSnapshotSchema = z.object({ snapshot: z.string() });

/** The owner feeds only the actual publication result, never a transaction. */
export function pendingRunAllowanceWindowsPlan(
  planned: ReturnType<typeof pendingRunAllowancePlan>,
  activation: RunAllowanceActivationInput,
  published: { readonly snapshot: string } | undefined,
) {
  if (planned.publication && !published) {
    throw new Error("Run allowance changed during refresh publication");
  }
  const entitlement =
    planned.entitlement && published
      ? { ...planned.entitlement, snapshot: published.snapshot }
      : planned.entitlement;
  if (!entitlement) {
    // Do not issue new windows after expiry. Already-issued windows remain
    // available through the existing run allowance availability graph.
    return undefined;
  }
  return {
    insert: runAllowanceWindowInsertSql(activation, entitlement),
    // Keep a subsequent statement's snapshot: an ON CONFLICT winner may not
    // have been visible when the insertion statement started.
    windows: runAllowanceWindowsQuery(
      activation.orgId,
      activation.runCreatedAt,
      entitlement,
    ),
  };
}
