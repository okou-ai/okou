import { officialWorkflowCreditAccess$ } from "./official-workflow-policy.service";
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/log";
import { settle } from "../utils";
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
  type ManagedUsageResource,
} from "./managed-usage-record";

import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { dataSearchJobs } from "@okouai/db/schema/data-search-job";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  exists,
  gt,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
  sum,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { safeSqlStateCode } from "../../lib/pg-errors";

import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import { processUsageEventKeys$ } from "./credit-usage.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";

export interface ManagedUsageErrorResponse {
  readonly status: 402 | 403 | 503;
  readonly body: {
    readonly error: {
      readonly message: string;
      readonly code: string;
    };
  };
}

function errorBody(message: string, code: string) {
  return { error: { message, code } };
}

export function closedOfficialRun(): ManagedUsageErrorResponse {
  return {
    status: 403,
    body: errorBody(
      "Official Workflow run is no longer active",
      "RESOURCE_UNAVAILABLE",
    ),
  };
}

export function insufficientCredits(): ManagedUsageErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

export function pricingNotConfigured(label: string): ManagedUsageErrorResponse {
  return {
    status: 503,
    body: errorBody(
      `${label} pricing is not configured`,
      "PRICING_NOT_CONFIGURED",
    ),
  };
}

export function estimatedCredits(
  unitPrice: bigint,
  unitSize: bigint,
  quantity: number,
): bigint {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("Managed usage quantity must be a positive safe integer");
  }
  if (unitPrice < 0n || unitSize <= 0n) {
    throw new Error(
      "Managed usage pricing must be non-negative with a positive unit size",
    );
  }
  const total = BigInt(quantity) * unitPrice;
  return (total + unitSize - 1n) / unitSize;
}

export interface ManagedUsageCreditCheckArgs {
  readonly runId?: string;
  readonly orgId: string;
  readonly userId: string;
  readonly resource: ManagedUsageResource;
  readonly label: string;
  readonly reservedCredits?: number;
}

const checkManagedCreditBalance$ = command(
  async (
    { set },
    args: ManagedUsageCreditCheckArgs,
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    const writeDb = set(writeDb$);
    const pricingProvider = args.resource.provider;
    const expired = writeDb.$with("expired").as(
      writeDb
        .select({
          total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
            .mapWith(pgInt8ToBigIntDecoder)
            .as("expired_total"),
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, args.orgId),
            lte(creditExpiresRecord.expiresAt, sql`now()`),
            gt(creditExpiresRecord.remaining, sql`0`),
          ),
        ),
    );
    const dataSearchReservation = writeDb
      .select({
        total:
          sql`COALESCE(${sum(dataSearchJobs.reservedCredits)}, 0)::bigint`.mapWith(
            pgInt8ToBigIntDecoder,
          ),
      })
      .from(dataSearchJobs)
      .where(
        and(
          eq(dataSearchJobs.orgId, args.orgId),
          isNull(dataSearchJobs.creditsCharged),
        ),
      );
    const rows = await writeDb
      .with(expired)
      .select({
        credits: sql`${orgMetadata.credits}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
        unsettledExpired: expired.total,
        // A durable data job has not debited the wallet yet. Every managed
        // service must leave that capacity available for its confirmed receipt.
        dataSearchReserved: sql`(${dataSearchReservation})`.mapWith(
          pgInt8ToBigIntDecoder,
        ),
        unitPrice: sql`${usagePricing.unitPrice}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
        unitSize: sql`${usagePricing.unitSize}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
      })
      .from(expired)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, args.orgId))
      .leftJoin(
        usagePricing,
        and(
          eq(usagePricing.kind, args.resource.kind),
          eq(usagePricing.provider, pricingProvider),
          eq(usagePricing.category, args.resource.category),
        ),
      );
    signal.throwIfAborted();

    const row = rows[0];
    if (row?.unitPrice === null || row?.unitSize === null) {
      return pricingNotConfigured(args.label);
    }

    if (!row || row.credits === null) {
      return insufficientCredits();
    }

    const credits = row.credits;
    const quantity = args.resource.quantity ?? 1;
    const requiredCredits =
      estimatedCredits(row.unitPrice, row.unitSize, quantity) +
      BigInt(args.reservedCredits ?? 0) +
      row.dataSearchReserved;
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (!capabilities || capabilities.status !== "active") {
      return insufficientCredits();
    }
    const access = await set(officialWorkflowCreditAccess$, args, signal);
    if (access === "closed") {
      return closedOfficialRun();
    }
    if (access === "free") {
      return null;
    }
    const spendableCredits = credits - row.unsettledExpired;
    const [memberCredits] = await writeDb
      .select({
        total:
          sql`COALESCE(SUM(${usagePackCreditGrants.remainingAmount}), 0)::bigint`.mapWith(
            pgInt8ToBigIntDecoder,
          ),
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, args.orgId),
          eq(usagePackCreditGrants.userId, args.userId),
          gt(usagePackCreditGrants.expiresAt, nowDate()),
          gt(usagePackCreditGrants.remainingAmount, 0),
        ),
      );
    signal.throwIfAborted();
    const usagePackCredits = memberCredits?.total ?? 0n;
    if (
      usagePackCredits + (spendableCredits > 0n ? spendableCredits : 0n) >=
      requiredCredits
    ) {
      return null;
    }

    return insufficientCredits();
  },
);

export const checkManagedCredits$ = command(
  async (
    { set },
    args: ManagedUsageCreditCheckArgs,
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    return await set(checkManagedCreditBalance$, args, signal);
  },
);

/** Billing is best-effort after provider success; cancellation still propagates. */
export const recordSuccessfulManagedUsage$ = command(
  async (
    { set },
    args: ManagedUsageRecordArgs,
    signal: AbortSignal,
  ): Promise<number | null> => {
    const outcome = await settle(set(recordManagedUsage$, args, signal));
    signal.throwIfAborted();
    if (!outcome.ok) {
      logger("ManagedUsage").error(
        "Failed to bill successful provider result",
        {
          kind: args.resource.kind,
          provider: args.resource.provider,
          orgId: args.actor.orgId,
          error: outcome.error,
        },
      );
      return null;
    }
    return outcome.value;
  },
);

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
