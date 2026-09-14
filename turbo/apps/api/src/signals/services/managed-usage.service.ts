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
} from "../context/usage-pricing-resolution";
import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { resolveActiveRunCreditAdmission } from "./run-admission.service";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";
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

export const checkManagedCredits$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
      readonly resource: ManagedUsageResource;
      readonly label: string;
    },
    signal: AbortSignal,
  ): Promise<ManagedUsageErrorResponse | null> => {
    const writeDb = set(writeDb$);
    const pricingProvider = resolveUsagePricingProvider(
      get(usagePricingResolution$),
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
    const requiredCredits = estimatedCredits(
      row.unitPrice,
      row.unitSize,
      quantity,
    );
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
    if (activeRunAdmission) {
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

    const allowance = await resolveUsageAllowanceAvailability(
      writeDb,
      args.orgId,
    );
    signal.throwIfAborted();
    const spendableUnits =
      usagePackCredits +
      (spendableCredits > 0n ? spendableCredits : 0n) +
      BigInt(allowance?.remainingUnits ?? 0);
    return spendableUnits >= requiredCredits ? null : insufficientCredits();
  },
);

export const recordManagedUsage$ = command(
  async (
    { set },
    args: {
      readonly actor: ManagedUsageActor;
      readonly resource: ManagedUsageResource;
      readonly label: string;
      readonly idempotencyKey?: string;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const writeDb = set(writeDb$);
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
      })
      .onConflictDoNothing({ target: usageEvent.idempotencyKey })
      .returning({ id: usageEvent.id });
    signal.throwIfAborted();

    const usageEventId = inserted?.id;

    await set(processOrgUsageEvents$, args.actor.orgId, signal);
    signal.throwIfAborted();

    const [processed] = await writeDb
      .select({
        orgId: usageEvent.orgId,
        userId: usageEvent.userId,
        kind: usageEvent.kind,
        provider: usageEvent.provider,
        category: usageEvent.category,
        quantity: usageEvent.quantity,
        billingError: usageEvent.billingError,
        creditsCharged: usageEvent.creditsCharged,
      })
      .from(usageEvent)
      .where(
        usageEventId
          ? eq(usageEvent.id, usageEventId)
          : eq(usageEvent.idempotencyKey, idempotencyKey),
      );
    signal.throwIfAborted();
    if (
      processed &&
      (processed.orgId !== args.actor.orgId ||
        processed.userId !== args.actor.userId ||
        processed.kind !== args.resource.kind ||
        processed.provider !== args.resource.provider ||
        processed.category !== args.resource.category ||
        processed.quantity !== (args.resource.quantity ?? 1))
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
  },
);
