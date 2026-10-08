import type { CreditBillingMode } from "@okouai/db/schema/credit-billing-mode";
import { randomUUID } from "node:crypto";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
export interface ManagedUsageResource {
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

export interface ManagedUsageRecordArgs {
  readonly actor: ManagedUsageActor;
  readonly creditBillingMode?: CreditBillingMode | null;
  readonly resource: ManagedUsageResource;
  readonly label: string;
  readonly idempotencyKey?: string;
  readonly pricingSnapshot?: ManagedUsagePricingSnapshot;
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

export function managedUsageReceiptCredits(
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

export function managedValues(
  args: ManagedUsageRecordArgs,
  run: { id: string } | undefined,
) {
  return {
    runId: run?.id ?? null,
    billingRunId: args.actor.runId,
    creditBillingMode: args.creditBillingMode ?? null,
    billingContext: args.actor.runId ? "missing_run" : "runless",
    idempotencyKey: args.idempotencyKey ?? randomUUID(),
    orgId: args.actor.orgId,
    userId: args.actor.userId,
    kind: args.resource.kind,
    provider: args.resource.provider,
    category: args.resource.category,
    quantity: args.resource.quantity ?? 1,
    pricingUnitPrice: args.pricingSnapshot?.unitPrice,
    pricingUnitSize: args.pricingSnapshot?.unitSize,
    pricingCreditsLimit: args.pricingSnapshot?.creditsLimit,
  };
}

export function receiptQuery(idempotencyKey: string) {
  return new QueryBuilder()
    .select()
    .from(usageEvent)
    .where(eq(usageEvent.idempotencyKey, idempotencyKey))
    .as("managed_usage_receipt");
}
