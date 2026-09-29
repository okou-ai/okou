import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import {
  attributedUsageIdentity,
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
} from "./managed-usage-attribution";

interface ProviderUsageBatch {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly billingRunId?: string | null;
  readonly billingContext: string;
  readonly events: readonly {
    readonly idempotencyKey: string;
    readonly kind: string;
    readonly provider: string;
    readonly category: string;
    readonly quantity: number;
  }[];
}

/** One provider response's categories and captured billing identity commit together. */
export const recordProviderUsageBatch$ = command(
  async (
    { set },
    args: ProviderUsageBatch,
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.events.length === 0) {
      return;
    }
    if (args.runId && args.billingRunId && args.runId !== args.billingRunId) {
      throw new Error("Live and billing Run identities disagree");
    }
    const runId = args.billingRunId ?? args.runId ?? undefined;
    const actor = { orgId: args.orgId, userId: args.userId, runId };
    const db = set(writeDb$);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      const [run] = runId
        ? await tx.select().from(managedBillingRunQuery(runId))
        : [];
      let [attribution] = runId
        ? await tx.select().from(managedAttributionQuery(runId))
        : [];
      if (!attribution && run) {
        const capture = managedAttributionWrite({ actor }, run);
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
            "Provider usage Run attribution conflicts with history",
          );
        }
      }
      const identity = attributedUsageIdentity({ actor }, run, attribution);
      const inserted = await tx
        .insert(usageEvent)
        .values(
          args.events.map((event) => {
            return {
              ...event,
              ...identity,
              orgId: args.orgId,
              userId: args.userId,
              // An old generation with no original identity is not proof of runless usage.
              ...(!runId && args.billingContext !== "runless"
                ? {
                    billingContext: "legacy_unknown",
                    billingAnchorAt: null,
                  }
                : {}),
              // Retained billing identity alone never restores a deleted content link.
              runId: args.runId === undefined ? null : identity.runId,
            };
          }),
        )
        .onConflictDoNothing({ target: usageEvent.idempotencyKey })
        .returning({ id: usageEvent.id });
      if (inserted.length > 0 && attribution) {
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
  },
);
