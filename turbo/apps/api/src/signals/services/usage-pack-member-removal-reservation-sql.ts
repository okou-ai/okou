import {
  usagePackAllocationChanges as changes,
  usagePackAllocations as allocations,
  usagePackSubscriptions as subscriptions,
} from "@okouai/db/schema/usage-pack-subscription";
import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { PgDialect, QueryBuilder, type PgColumn } from "drizzle-orm/pg-core";
import { literal, uuid } from "zod";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";

interface ReservationInput {
  readonly orgId: string;
  readonly userId: string;
  readonly at: Date;
  readonly expiresAt: Date;
}
function returned(columns: Readonly<Record<string, PgColumn>>) {
  return Object.entries(columns).map(([name, field]) => {
    return { path: [name], field };
  });
}
function expirePreviews(input: ReservationInput) {
  return new PgDialect().buildUpdateQuery({
    table: changes,
    set: {
      status: sql.param("failed", changes.status),
      failureReason: sql.param("preview_expired", changes.failureReason),
      completedAt: sql.param(input.at, changes.completedAt),
      updatedAt: sql.param(input.at, changes.updatedAt),
    },
    where: and(
      eq(changes.orgId, input.orgId),
      eq(changes.status, "previewed"),
      lte(changes.previewExpiresAt, input.at),
    ),
    joins: [],
    returning: returned({ id: changes.id }),
  });
}
function adjustPreviews(input: ReservationInput) {
  const retained = sql`${changes.id} = (SELECT id FROM existing_removal)`;
  const renewing = sql`${retained} AND ${eq(changes.kind, "removal")} AND ${eq(changes.status, "previewed")}`;
  return new PgDialect().buildUpdateQuery({
    table: changes,
    set: {
      status: sql`CASE WHEN ${retained} THEN ${changes.status} ELSE 'failed' END`,
      failureReason: sql`CASE WHEN ${retained} THEN ${changes.failureReason} ELSE 'member_removal_reserved' END`,
      completedAt: sql`CASE WHEN ${retained} THEN ${changes.completedAt} ELSE ${sql.param(input.at, changes.completedAt)}::timestamp END`,
      updatedAt: sql`CASE WHEN ${retained} AND NOT (${renewing}) THEN ${changes.updatedAt} ELSE ${sql.param(input.at, changes.updatedAt)}::timestamp END`,
      previewExpiresAt: sql`CASE WHEN ${renewing} THEN ${sql.param(input.expiresAt, changes.previewExpiresAt)}::timestamp ELSE ${changes.previewExpiresAt} END`,
    },
    where: and(
      sql`EXISTS (SELECT 1 FROM eligible)`,
      sql`NOT EXISTS (SELECT 1 FROM expired WHERE expired.id = ${changes.id})`,
      or(
        and(eq(changes.orgId, input.orgId), eq(changes.status, "previewed")),
        sql`${changes.id} = (SELECT id FROM existing_removal)`,
      ),
    ),
    joins: [],
    returning: returned({
      id: changes.id,
      kind: changes.kind,
      status: changes.status,
    }),
  });
}
function insertReservation(input: ReservationInput) {
  // Full schema column order is owned by PgDialect. Omitted nullable values
  // remain NULL, matching the original partial insert and current defaults.
  return new PgDialect().buildInsertQuery({
    table: changes,
    select: true,
    values: sql`SELECT gen_random_uuid(), subscription.id, NULL, ${sql.param(input.orgId, changes.orgId)}, ${sql.param(input.userId, changes.userId)}, allocation.id, NULL, 'removal', 'previewed', allocation.usage_pack_usd, allocation.stripe_price_id, NULL, NULL, NULL, 0, 0, NULL, NULL, ${sql.param(input.expiresAt, changes.previewExpiresAt)}::timestamp, NULL, NULL, NULL, NULL, NULL, ${sql.param(input.at, changes.createdAt)}::timestamp, ${sql.param(input.at, changes.updatedAt)}::timestamp FROM allocation CROSS JOIN subscription WHERE EXISTS (SELECT 1 FROM eligible) AND NOT EXISTS (SELECT 1 FROM existing_removal) AND (SELECT ${count()} FROM adjusted) >= 0`,
    onConflict: sql`do nothing`,
    returning: returned({ id: changes.id }),
  });
}
/** One statement owns preview cleanup, the existing allocation lock and reservation. */
export function memberRemovalReservationPlan(input: ReservationInput) {
  const qb = new QueryBuilder();
  return {
    ctes: [
      qb.$with("expired", {}).as(expirePreviews(input)),
      qb.$with("allocation", {}).as(
        qb
          .select(getTableColumns(allocations))
          .from(allocations)
          .where(
            and(
              eq(allocations.orgId, input.orgId),
              eq(allocations.userId, input.userId),
              eq(allocations.status, "active"),
              sql`(SELECT ${count()} FROM expired) >= 0`,
            ),
          )
          .for("update")
          .limit(1)
          .getSQL(),
      ),
      qb.$with("subscription", {}).as(
        qb
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.orgId, input.orgId),
              isNotNull(subscriptions.stripeSubscriptionId),
              notInArray(subscriptions.subscriptionStatus, [
                "canceled",
                "incomplete_expired",
                "invalid",
              ]),
              sql`EXISTS (SELECT 1 FROM allocation)`,
            ),
          )
          .orderBy(desc(subscriptions.updatedAt))
          .limit(1)
          .getSQL(),
      ),
      qb.$with("current_changes", {}).as(
        qb
          .select(getTableColumns(changes))
          .from(changes)
          .where(
            and(
              eq(
                changes.usagePackSubscriptionId,
                sql`(SELECT id FROM subscription)`,
              ),
              inArray(changes.status, [
                "previewed",
                "applying",
                "pending_payment",
                "scheduled",
                "applied",
              ]),
              sql`NOT EXISTS (SELECT 1 FROM expired WHERE expired.id = ${changes.id})`,
            ),
          )
          .getSQL(),
      ),
      qb
        .$with("blocking", {})
        .as(
          sql`SELECT id FROM current_changes WHERE status IN ('applying', 'pending_payment', 'applied') LIMIT 1`,
        ),
      qb
        .$with("existing_change", {})
        .as(
          sql`SELECT * FROM current_changes WHERE user_id = ${input.userId} LIMIT 1`,
        ),
      qb
        .$with("existing_removal", {})
        .as(sql`SELECT * FROM existing_change WHERE kind = 'removal'`),
      qb
        .$with("eligible", {})
        .as(
          sql`SELECT id FROM subscription WHERE NOT EXISTS (SELECT 1 FROM blocking) AND NOT EXISTS (SELECT 1 FROM existing_change WHERE status = 'scheduled' AND kind <> 'removal')`,
        ),
      qb.$with("adjusted", {}).as(adjustPreviews(input)),
      qb.$with("reserved", {}).as(insertReservation(input)),
    ],
    from: sql`(SELECT 1) AS reservation_result`,
    fields: {
      reservationId:
        sql`COALESCE((SELECT id FROM reserved),(SELECT adjusted.id FROM adjusted JOIN existing_removal ON existing_removal.id = adjusted.id WHERE adjusted.kind = 'removal' AND adjusted.status IN ('previewed','scheduled')))`.mapWith(
          zodDriverValueDecoder(uuid().nullable()),
        ),
      atomicGuard: sql`(CASE
 WHEN NOT EXISTS (SELECT 1 FROM allocation) THEN '0'
 WHEN NOT EXISTS (SELECT 1 FROM subscription) THEN '__TX0267_GUARD_V1_NOT_READY__'
 WHEN EXISTS (SELECT 1 FROM blocking) THEN (SELECT '__TX0267_GUARD_V1_BLOCKED_' || id || '__' FROM blocking)
 WHEN EXISTS (SELECT 1 FROM existing_change WHERE status = 'scheduled' AND kind <> 'removal') THEN (SELECT '__TX0267_GUARD_V1_EXISTING_' || id || '__' FROM existing_change)
 WHEN EXISTS (SELECT 1 FROM existing_removal) AND NOT EXISTS (SELECT 1 FROM adjusted JOIN existing_removal ON existing_removal.id = adjusted.id WHERE adjusted.kind = 'removal' AND adjusted.status IN ('previewed','scheduled')) THEN '__TX0267_GUARD_V1_CONFLICT__'
 WHEN NOT EXISTS (SELECT 1 FROM existing_removal) AND NOT EXISTS (SELECT 1 FROM reserved) THEN '__TX0267_GUARD_V1_CONFLICT__'
 ELSE '0' END)::integer`.mapWith(zodDriverValueDecoder(literal(0))),
    },
  };
}
