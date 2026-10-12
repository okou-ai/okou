import { randomUUID } from "node:crypto";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import {
  attributedManagedValues,
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
} from "./managed-usage-attribution";
import {
  managedUsageReceiptCredits,
  receiptQuery,
  type ManagedUsageRecordArgs,
  type ManagedUsageResource,
} from "./managed-usage-record";

import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";
import { nowDate } from "../../lib/time";

import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { writeDb$, type Db } from "../external/db";
import { processUsageEventKeys$ } from "./credit-usage.service";
import {
  loadOrgPlanCapabilities,
  loadOrgPlanCapabilities$,
} from "./org-plan-entitlement-read.service";
import { resolveActiveRunCreditAdmission } from "./run-admission.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";

export interface ManagedUsageErrorResponse {
  readonly status: 402 | 503;
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

function insufficientCredits(): ManagedUsageErrorResponse {
  return {
    status: 402,
    body: errorBody(
      "Insufficient credits. Please add credits to continue.",
      "INSUFFICIENT_CREDITS",
    ),
  };
}

function pricingNotConfigured(label: string): ManagedUsageErrorResponse {
  return {
    status: 503,
    body: errorBody(
      `${label} pricing is not configured`,
      "PRICING_NOT_CONFIGURED",
    ),
  };
}

function estimatedCredits(
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
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
  readonly resource: ManagedUsageResource;
  readonly label: string;
  readonly reservedCredits?: number;
  readonly enforceBalance?: boolean;
}

/** Check spendable credits within the caller's admission transaction. */
export async function checkManagedCreditsSnapshotInDb(
  writeDb: Db,
  args: ManagedUsageCreditCheckArgs,
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | null> {
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
  const rows = await writeDb
    .with(expired)
    .select({
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
      ),
      unsettledExpired: expired.total,
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
    BigInt(args.reservedCredits ?? 0);
  const capabilities = await loadOrgPlanCapabilities(writeDb, args.orgId);
  signal.throwIfAborted();
  if (!capabilities || capabilities.status !== "active") {
    return insufficientCredits();
  }
  const activeRunAdmission = await resolveActiveRunCreditAdmission({
    db: writeDb,
    runId: args.runId,
    orgId: args.orgId,
    userId: args.userId,
  });
  signal.throwIfAborted();
  if (activeRunAdmission && !args.enforceBalance) {
    return null;
  }
  const spendableCredits = credits - row.unsettledExpired;
  const usagePackCredits = BigInt(
    await getSpendableUsagePackCredits(writeDb, {
      orgId: args.orgId,
      userId: args.userId,
    }),
  );
  signal.throwIfAborted();
  if (
    usagePackCredits + (spendableCredits > 0n ? spendableCredits : 0n) >=
    requiredCredits
  ) {
    return null;
  }

  return insufficientCredits();
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
    const rows = await writeDb
      .with(expired)
      .select({
        credits: sql`${orgMetadata.credits}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToBigIntDecoder),
        ),
        unsettledExpired: expired.total,
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
      BigInt(args.reservedCredits ?? 0);
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (!capabilities || capabilities.status !== "active") {
      return insufficientCredits();
    }
    const activeRunAdmission = await resolveActiveRunCreditAdmission({
      db: set(writeDb$),
      runId: args.runId,
      orgId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();
    if (activeRunAdmission && !args.enforceBalance) {
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0178; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      const [run] = args.actor.runId
        ? await tx.select().from(managedBillingRunQuery(args.actor.runId))
        : [];
      let [attribution] = args.actor.runId
        ? await tx.select().from(managedAttributionQuery(args.actor.runId))
        : [];
      if (!attribution && run) {
        const capture = managedAttributionWrite(args, run);
        [attribution] = await tx
          .insert(billingRunAttribution)
          .values(capture.values)
          .onConflictDoUpdate(capture.conflict)
          .returning({
            runId: billingRunAttribution.runId,
            orgId: billingRunAttribution.orgId,
            userId: billingRunAttribution.userId,
            startedAt: sql`${billingRunAttribution.runStartedAt}::text`.mapWith(
              pgTextDecoder,
            ),
          });
        if (!attribution) {
          throw new Error(
            "Managed usage Run attribution conflicts with history",
          );
        }
      }
      const [inserted] = await tx
        .insert(usageEvent)
        .values(attributedManagedValues(identity, run, attribution))
        .onConflictDoNothing({ target: usageEvent.idempotencyKey })
        .returning({ id: usageEvent.id });
      if (inserted && attribution) {
        await tx
          .update(billingRunAttribution)
          .set({ usageObserved: true })
          .where(
            and(
              eq(billingRunAttribution.runId, attribution.runId),
              eq(billingRunAttribution.usageObserved, false),
            ),
          );
      }
      signal.throwIfAborted();
    });
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
