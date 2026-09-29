import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { sql } from "drizzle-orm";
import {
  attributedManagedValues,
  type BillingAttribution,
  type BillingRun,
} from "./managed-usage-attribution";
import type { ManagedUsageRecordArgs } from "./managed-usage-record";

export function capturedManagedAttribution(
  run: BillingRun,
  captured: { readonly runId: string } | undefined,
): BillingAttribution {
  if (captured?.runId !== run.id) {
    throw new Error("Managed usage Run attribution conflicts with history");
  }
  return {
    runId: run.id,
    orgId: run.orgId,
    userId: run.userId,
    startedAt: run.startedAt,
  };
}

/** The owning command executes this bounded publication; no handle is accepted. */
export function managedUsagePublicationSql(
  args: ManagedUsageRecordArgs,
  run: BillingRun | undefined,
  attribution: BillingAttribution | undefined,
) {
  const values = attributedManagedValues(args, run, attribution);
  return sql`
    WITH inserted AS (
      INSERT INTO ${usageEvent} (
        run_id, billing_run_id, billing_context, billing_anchor_at, created_at,
        idempotency_key, org_id, user_id, kind, provider, category, quantity,
        pricing_unit_price, pricing_unit_size, pricing_credits_limit
      ) VALUES (
        ${values.runId}, ${values.billingRunId}, ${values.billingContext},
        ${values.billingAnchorAt}, ${values.createdAt},
        ${values.idempotencyKey}, ${values.orgId}, ${values.userId},
        ${values.kind}, ${values.provider}, ${values.category},
        ${values.quantity}, ${values.pricingUnitPrice ?? null},
        ${values.pricingUnitSize ?? null}, ${values.pricingCreditsLimit ?? null}
      ) ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING billing_run_id, billing_context
    )
    UPDATE ${billingRunAttribution} SET usage_observed = true
    WHERE NOT usage_observed AND run_id IN (
      SELECT billing_run_id FROM inserted WHERE billing_context = 'run'
    )
  `;
}
