import { randomUUID } from "node:crypto";

import { agentRuns } from "@okouai/db/runtime/agent-run";
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
import type { Tx } from "../../lib/db-types";
import {
  processOrgUsageEvents$,
  processOrgUsageEventsInTransaction,
  type ProcessOrgUsageEventsResult,
} from "./credit-usage.service";
import { lockUsageEventCompaction } from "./usage-event-compaction-lock.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { resolveActiveRunCreditAdmission } from "./run-admission.service";
import {
  lockOrgCredits,
  readUsageAllowanceAvailabilitySnapshot,
  resolveUsageAllowanceAvailability,
} from "./usage-allowance.service";
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

interface ManagedUsageResource {
  readonly kind: string;
  readonly provider: string;
  readonly category: string;
  readonly quantity?: number;
}

interface ManagedUsageActor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

export interface ManagedUsagePricingSnapshot {
  readonly unitPrice: number;
  readonly unitSize: number;
  readonly creditsLimit: number;
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

export interface ManagedUsageRecordArgs {
  readonly actor: ManagedUsageActor;
  readonly resource: ManagedUsageResource;
  readonly label: string;
  readonly idempotencyKey?: string;
  readonly pricingSnapshot?: ManagedUsagePricingSnapshot;
}

export interface ManagedUsageRecordResult {
  readonly creditsCharged: number;
  readonly effects: ProcessOrgUsageEventsResult;
}

type ManagedUsageReceipt = Pick<
  typeof usageEvent.$inferSelect,
  | "orgId"
  | "userId"
  | "kind"
  | "provider"
  | "category"
  | "quantity"
  | "pricingUnitPrice"
  | "pricingUnitSize"
  | "pricingCreditsLimit"
  | "billingError"
  | "creditsCharged"
>;

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

export async function checkManagedCreditsInDb(
  writeDb: Db,
  args: ManagedUsageCreditCheckArgs,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ManagedUsageErrorResponse | null> {
  const balance = await checkManagedCreditBalance(
    writeDb,
    args,
    pricingResolution,
    signal,
  );
  if (!balance || "status" in balance) {
    return balance;
  }
  const allowance = await resolveUsageAllowanceAvailability(
    writeDb,
    args.orgId,
  );
  signal.throwIfAborted();
  return balance.spendableCredits + BigInt(allowance?.remainingUnits ?? 0) >=
    balance.requiredCredits
    ? null
    : insufficientCredits();
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
    return await checkManagedCreditsInDb(
      set(writeDb$),
      args,
      get(usagePricingResolution$),
      signal,
    );
  },
);

function managedUsageReceiptCredits(
  args: ManagedUsageRecordArgs,
  processed: ManagedUsageReceipt | undefined,
): number {
  const pricingSnapshot = args.pricingSnapshot ?? {
    unitPrice: null,
    unitSize: null,
    creditsLimit: null,
  };
  if (
    processed &&
    (processed.orgId !== args.actor.orgId ||
      processed.userId !== args.actor.userId ||
      processed.kind !== args.resource.kind ||
      processed.provider !== args.resource.provider ||
      processed.category !== args.resource.category ||
      processed.quantity !== (args.resource.quantity ?? 1) ||
      processed.pricingUnitPrice !== pricingSnapshot.unitPrice ||
      processed.pricingUnitSize !== pricingSnapshot.unitSize ||
      processed.pricingCreditsLimit !== pricingSnapshot.creditsLimit)
  ) {
    throw new Error(`${args.label} usage idempotency key collision`);
  }
  if (!processed || processed.creditsCharged === null) {
    throw new Error(`Failed to process ${args.label} usage event`);
  }
  if (processed.billingError !== null) {
    throw new Error(
      `Failed to bill ${args.label} usage event: ${processed.billingError}`,
    );
  }
  return processed.creditsCharged;
}

interface ManagedUsageEventIdentity {
  readonly usageEventId: string | undefined;
  readonly idempotencyKey: string;
}

async function insertManagedUsageEvent(
  writeDb: Db,
  args: ManagedUsageRecordArgs,
  signal: AbortSignal,
): Promise<ManagedUsageEventIdentity> {
  const [run] = args.actor.runId
    ? await writeDb
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, args.actor.runId),
            eq(agentRuns.orgId, args.actor.orgId),
            eq(agentRuns.userId, args.actor.userId),
          ),
        )
    : [];
  signal.throwIfAborted();

  const idempotencyKey = args.idempotencyKey ?? randomUUID();
  const [inserted] = await writeDb
    .insert(usageEvent)
    .values({
      runId: run?.id ?? null,
      // The live lookup may lose a deleted run; retain the supplied identity
      // without changing this slice's existing settlement path.
      billingRunId: args.actor.runId,
      billingContext: args.actor.runId ? "missing_run" : "runless",
      idempotencyKey,
      orgId: args.actor.orgId,
      userId: args.actor.userId,
      kind: args.resource.kind,
      provider: args.resource.provider,
      category: args.resource.category,
      quantity: args.resource.quantity ?? 1,
      pricingUnitPrice: args.pricingSnapshot?.unitPrice,
      pricingUnitSize: args.pricingSnapshot?.unitSize,
      pricingCreditsLimit: args.pricingSnapshot?.creditsLimit,
    })
    .onConflictDoNothing({ target: usageEvent.idempotencyKey })
    .returning({ id: usageEvent.id });
  signal.throwIfAborted();
  return { usageEventId: inserted?.id, idempotencyKey };
}

async function readManagedUsageReceipt(
  writeDb: Db,
  identity: ManagedUsageEventIdentity,
  signal: AbortSignal,
): Promise<ManagedUsageReceipt | undefined> {
  const [processed] = await writeDb
    .select({
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      pricingUnitPrice: usageEvent.pricingUnitPrice,
      pricingUnitSize: usageEvent.pricingUnitSize,
      pricingCreditsLimit: usageEvent.pricingCreditsLimit,
      billingError: usageEvent.billingError,
      creditsCharged: usageEvent.creditsCharged,
    })
    .from(usageEvent)
    .where(
      identity.usageEventId
        ? eq(usageEvent.id, identity.usageEventId)
        : eq(usageEvent.idempotencyKey, identity.idempotencyKey),
    );
  signal.throwIfAborted();
  return processed;
}

export async function recordManagedUsageInTransaction(
  tx: Tx,
  args: ManagedUsageRecordArgs,
  pricingResolution: UsagePricingResolution,
  signal: AbortSignal,
): Promise<ManagedUsageRecordResult> {
  await lockUsageEventCompaction(tx, "shared");
  await lockOrgCredits(tx, args.actor.orgId);
  signal.throwIfAborted();
  const identity = await insertManagedUsageEvent(tx, args, signal);
  signal.throwIfAborted();
  const effects = await processOrgUsageEventsInTransaction(
    tx,
    args.actor.orgId,
    pricingResolution,
    signal,
  );
  signal.throwIfAborted();
  const processed = await readManagedUsageReceipt(tx, identity, signal);
  signal.throwIfAborted();
  return {
    creditsCharged: managedUsageReceiptCredits(args, processed),
    effects,
  };
}

export const recordManagedUsage$ = command(
  async (
    { set },
    args: ManagedUsageRecordArgs,
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);
    const identity = await insertManagedUsageEvent(writeDb, args, signal);
    signal.throwIfAborted();
    await set(processOrgUsageEvents$, args.actor.orgId, signal);
    signal.throwIfAborted();
    const processed = await readManagedUsageReceipt(writeDb, identity, signal);
    signal.throwIfAborted();
    return managedUsageReceiptCredits(args, processed);
  },
);
