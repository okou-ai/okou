import { usageAllowanceAllocations } from "@okouai/db/schema/org-usage-allowance";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usageEventHourlyRollup } from "@okouai/db/schema/usage-event-hourly-rollup";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";

const FINALIZED_USAGE_RELATION_ALIAS = "finalized_usage";

interface FinalizedUsageBounds {
  readonly start?: Date;
  readonly end?: Date;
}

export function buildFinalizedUsageRelation(bounds?: FinalizedUsageBounds) {
  const queryBuilder = new QueryBuilder();
  const rawRows = queryBuilder
    .select({
      processedHour: sql`date_trunc('hour', ${usageEvent.processedAt})`
        .mapWith(usageEvent.processedAt)
        .as("processed_hour"),
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      runId: usageEvent.runId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      shortWindowId: usageAllowanceAllocations.shortWindowId,
      weeklyWindowId: usageAllowanceAllocations.weeklyWindowId,
      quantity: usageEvent.quantity,
      creditsCharged: sql`COALESCE(${usageEvent.creditsCharged}, 0)::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits_charged"),
      allowanceUnits:
        sql`COALESCE(${usageAllowanceAllocations.unitsApplied}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("allowance_units"),
    })
    .from(usageEvent)
    .leftJoin(
      usageAllowanceAllocations,
      eq(usageAllowanceAllocations.usageEventId, usageEvent.id),
    )
    .where(
      and(
        eq(usageEvent.status, "processed"),
        isNotNull(usageEvent.processedAt),
        bounds?.start ? gte(usageEvent.processedAt, bounds.start) : undefined,
        bounds?.end ? lt(usageEvent.processedAt, bounds.end) : undefined,
      ),
    );
  const hourlyRows = queryBuilder
    .select({
      processedHour: usageEventHourlyRollup.processedHour,
      orgId: usageEventHourlyRollup.orgId,
      userId: usageEventHourlyRollup.userId,
      runId: usageEventHourlyRollup.runId,
      kind: usageEventHourlyRollup.kind,
      provider: usageEventHourlyRollup.provider,
      category: usageEventHourlyRollup.category,
      shortWindowId: usageEventHourlyRollup.shortWindowId,
      weeklyWindowId: usageEventHourlyRollup.weeklyWindowId,
      quantity: usageEventHourlyRollup.quantity,
      creditsCharged: usageEventHourlyRollup.creditsCharged,
      allowanceUnits: usageEventHourlyRollup.allowanceUnits,
    })
    .from(usageEventHourlyRollup)
    .where(
      and(
        bounds?.start
          ? gte(usageEventHourlyRollup.processedHour, bounds.start)
          : undefined,
        bounds?.end
          ? lt(usageEventHourlyRollup.processedHour, bounds.end)
          : undefined,
      ),
    );

  return rawRows.unionAll(hourlyRows).as(FINALIZED_USAGE_RELATION_ALIAS);
}

export type FinalizedUsageRelation = ReturnType<
  typeof buildFinalizedUsageRelation
>;
