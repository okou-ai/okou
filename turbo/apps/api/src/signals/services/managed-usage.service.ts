import { randomUUID } from "node:crypto";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, count, eq, exists, ne, notExists, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";
import { pgIntegerDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import { processUsageEventKeys$ } from "./credit-usage.service";
import {
  attributedManagedValues,
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
  type BillingAttribution,
  type BillingRun,
} from "./managed-usage-attribution";
import {
  managedUsageReceiptCredits,
  receiptQuery,
  type ManagedUsageRecordArgs,
} from "./managed-usage-record";

/** A statement-snapshot prediction, checked against actual INSERT RETURNING. */
function managedUsageInsertionExpected(idempotencyKey: string) {
  return notExists(
    new QueryBuilder()
      .select({ id: usageEvent.id })
      .from(usageEvent)
      .where(eq(usageEvent.idempotencyKey, idempotencyKey)),
  );
}

function preparedManagedUsageValues(
  args: ManagedUsageRecordArgs,
  identity: ManagedUsageRecordArgs,
  run: BillingRun | undefined,
  attribution: BillingAttribution | undefined,
) {
  const capture =
    !attribution && run ? managedAttributionWrite(args, run) : undefined;
  // A successful capture's immutable identity must equal these Run fields.
  // Its actual RETURNING cardinality guards the event write before commit.
  const expectedAttribution =
    attribution ??
    (capture && run
      ? {
          runId: run.id,
          orgId: run.orgId,
          userId: run.userId,
          startedAt: run.startedAt,
        }
      : undefined);
  return {
    capture,
    values: attributedManagedValues(identity, run, expectedAttribution),
  };
}

export const recordManagedUsage$ = command(
  async (
    { set },
    args: ManagedUsageRecordArgs,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const identity = {
      ...args,
      idempotencyKey: args.idempotencyKey ?? randomUUID(),
    };
    await (async () => {
      const [run] = args.actor.runId
        ? await db.select().from(managedBillingRunQuery(args.actor.runId))
        : [];
      const [attribution] = args.actor.runId
        ? await db.select().from(managedAttributionQuery(args.actor.runId))
        : [];
      const { capture, values } = preparedManagedUsageValues(
        args,
        identity,
        run,
        attribution,
      );
      if (capture) {
        const expectedInsert = managedUsageInsertionExpected(
          identity.idempotencyKey,
        );
        const captured = db.$with("managed_captured_attribution").as(
          db
            .insert(billingRunAttribution)
            .values({ ...capture.values, usageObserved: expectedInsert })
            .onConflictDoUpdate({
              ...capture.conflict,
              set: {
                ...capture.conflict.set,
                usageObserved: or(
                  eq(billingRunAttribution.usageObserved, true),
                  expectedInsert,
                ),
              },
            })
            .returning({ runId: billingRunAttribution.runId }),
        );
        const captureCount = db.select({ value: count() }).from(captured);
        const inserted = db.$with("managed_inserted_usage").as(
          db
            .insert(usageEvent)
            .values({
              ...values,
              // Consume the real capture before the event's Run FK lock.
              // Count1 preserves the exact bigint quantity; count0 aborts all writes.
              quantity: sql`${sql.param(values.quantity, usageEvent.quantity)}::bigint / (${captureCount})`,
            })
            .onConflictDoNothing({ target: usageEvent.idempotencyKey })
            .returning({ id: usageEvent.id }),
        );
        const insertedCount = db.select({ value: count() }).from(inserted);
        const query = db
          .with(captured, inserted)
          .select({
            checked: sql`1 / CASE WHEN ${ne(count(), 1)} THEN 0 WHEN ${ne(
              sql`(${insertedCount})`,
              sql`CASE WHEN ${expectedInsert} THEN 1 ELSE 0 END`,
            )} THEN 0 ELSE 1 END`.mapWith(pgIntegerDecoder),
          })
          .from(captured);
        // A concurrent idempotency winner can invalidate this statement's
        // prediction. Re-execute once after rollback under a fresh snapshot,
        // keeping the same identity, key, values and capture-before-FK order.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const published = await settle(
            (async () => {
              await query;
            })(),
          );
          signal.throwIfAborted();
          if (published.ok) {
            return;
          }
          if (safeSqlStateCode(published.error) !== "22012") {
            throw published.error;
          }
          if (attempt === 1) {
            throw new Error(
              "Managed usage Run attribution conflicts with history",
            );
          }
        }
      }
      const inserted = db
        .$with("managed_inserted_usage")
        .as(
          db
            .insert(usageEvent)
            .values(values)
            .onConflictDoNothing({ target: usageEvent.idempotencyKey })
            .returning({ id: usageEvent.id }),
        );
      if (attribution) {
        const observed = db.$with("managed_observed_attribution").as(
          db
            .update(billingRunAttribution)
            .set({ usageObserved: true })
            .where(
              and(
                eq(billingRunAttribution.runId, attribution.runId),
                eq(billingRunAttribution.usageObserved, false),
                exists(db.select({ id: inserted.id }).from(inserted)),
              ),
            ),
        );
        await db
          .with(inserted, observed)
          .select({ id: inserted.id })
          .from(inserted);
      } else {
        await db.with(inserted).select({ id: inserted.id }).from(inserted);
      }
      signal.throwIfAborted();
    })();
    signal.throwIfAborted();
    await set(
      processUsageEventKeys$,
      { orgId: args.actor.orgId, idempotencyKeys: [identity.idempotencyKey] },
      signal,
    );
    signal.throwIfAborted();
    const [processed] = await db
      .select()
      .from(receiptQuery(identity.idempotencyKey));
    signal.throwIfAborted();
    return managedUsageReceiptCredits(args, processed);
  },
);
