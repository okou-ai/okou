import { randomUUID } from "node:crypto";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/runtime/usage-event";
import { command } from "ccstate";
import { and, eq, exists } from "drizzle-orm";
import { writeDb$ } from "../external/db";
import { processUsageEventKeys$ } from "./credit-usage.service";
import {
  attributedUsageIdentity,
  managedBillingRunQuery,
  type BillingAttribution,
} from "./managed-usage-attribution";

export const recordDataRouterUsage$ = command(
  async (
    { set },
    attribution: BillingAttribution,
    credits: number,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const idempotencyKey = randomUUID();
    const [run] = await db
      .select()
      .from(managedBillingRunQuery(attribution.runId));
    signal.throwIfAborted();
    const values = {
      ...attributedUsageIdentity({ actor: attribution }, run, attribution),
      idempotencyKey,
      orgId: attribution.orgId,
      userId: attribution.userId,
      kind: "data-search",
      provider: "data-router",
      category: "credits",
      quantity: credits,
    };
    const inserted = db
      .$with("data_router_inserted_usage")
      .as(
        db
          .insert(usageEvent)
          .values(values)
          .onConflictDoNothing({ target: usageEvent.idempotencyKey })
          .returning({ id: usageEvent.id }),
      );
    const observed = db.$with("data_router_observed_attribution").as(
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
    signal.throwIfAborted();
    await set(
      processUsageEventKeys$,
      { orgId: attribution.orgId, idempotencyKeys: [idempotencyKey] },
      signal,
    );
    signal.throwIfAborted();
    const [processed] = await db
      .select()
      .from(usageEvent)
      .where(eq(usageEvent.idempotencyKey, idempotencyKey));
    signal.throwIfAborted();
    if (
      processed &&
      (processed.orgId !== values.orgId ||
        processed.userId !== values.userId ||
        processed.kind !== values.kind ||
        processed.provider !== values.provider ||
        processed.category !== values.category ||
        processed.quantity !== credits)
    ) {
      throw new Error("Data Search usage idempotency key collision");
    }
    if (!processed || processed.creditsCharged === null) {
      throw new Error("Failed to process Data Search usage event");
    }
    if (processed.billingError !== null) {
      throw new Error(
        `Failed to bill Data Search usage event: ${processed.billingError}`,
      );
    }
    return processed.creditsCharged;
  },
);
