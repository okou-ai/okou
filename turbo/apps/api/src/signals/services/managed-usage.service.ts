import { resolveUsageAllowanceAvailability$ } from "./usage-allowance-availability.service";
import {
  managedUsageReceiptCredits,
  managedRunQuery,
  managedValues,
  receiptQuery,
  type ManagedUsageRecordArgs,
  type ManagedUsageResource,
} from "./managed-usage-record";
import { randomUUID } from "node:crypto";

import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { usagePricing } from "@okouai/db/schema/usage-pricing";
import { command } from "ccstate";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgInt8ToBigIntDecoder,
} from "../../lib/db-structured-result";
import {
  resolveUsagePricingProvider,
  usagePricingResolution$,
  type UsagePricingResolution,
} from "../context/usage-pricing-resolution";
import { writeDb$, type Db } from "../external/db";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { resolveActiveRunCreditAdmission } from "./run-admission.service";
import { readUsageAllowanceAvailabilitySnapshot } from "./usage-allowance.service";
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

interface ManagedUsageUncoveredBalance {
  readonly requiredCredits: bigint;
  readonly spendableCredits: bigint;
}

async function checkManagedCreditBalance(
  writeDb: Db,
  args: ManagedUsageCreditCheckArgs,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | ManagedUsageUncoveredBalance | null> {
  const pricingProvider = resolveUsagePricingProvider(
    pricingResolution,
    args.resource.kind,
    args.resource.provider,
  );
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

  return {
    requiredCredits,
    spendableCredits:
      usagePackCredits + (spendableCredits > 0n ? spendableCredits : 0n),
  };
}

/** The caller releases its owner row before performing any allowance refresh. */
export async function checkManagedCreditsSnapshotInDb(
  writeDb: Db,
  args: ManagedUsageCreditCheckArgs,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | "allowance_refresh_required" | null> {
  const balance = await checkManagedCreditBalance(
    writeDb,
    args,
    pricingResolution,
    signal,
  );
  if (!balance || "status" in balance) {
    return balance;
  }
  const allowance = await readUsageAllowanceAvailabilitySnapshot(
    writeDb,
    args.orgId,
  );
  signal.throwIfAborted();
  if (allowance === "allowance_refresh_required") {
    return allowance;
  }
  return balance.spendableCredits + BigInt(allowance?.remainingUnits ?? 0) >=
    balance.requiredCredits
    ? null
    : insufficientCredits();
}

export const checkManagedCredits$ = command(
  async (
    { get, set },
    args: ManagedUsageCreditCheckArgs,
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    const balance = await checkManagedCreditBalance(
      set(writeDb$),
      args,
      get(usagePricingResolution$),
      signal,
    );
    signal.throwIfAborted();
    if (!balance || "status" in balance) {
      return balance;
    }
    const allowance = await set(
      resolveUsageAllowanceAvailability$,
      args.orgId,
      signal,
    );
    signal.throwIfAborted();
    return balance.spendableCredits + BigInt(allowance?.remainingUnits ?? 0) >=
      balance.requiredCredits
      ? null
      : insufficientCredits();
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
    await db.transaction(async (tx) => {
      const [run] = args.actor.runId
        ? await tx.select().from(managedRunQuery(args))
        : [];
      await tx
        .insert(usageEvent)
        .values(managedValues(identity, run))
        .onConflictDoNothing({ target: usageEvent.idempotencyKey });
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    await set(processOrgUsageEvents$, args.actor.orgId, signal);
    signal.throwIfAborted();
    const [processed] = await db
      .select()
      .from(receiptQuery(identity.idempotencyKey));
    signal.throwIfAborted();
    return managedUsageReceiptCredits(args, processed);
  },
);
