import { randomUUID } from "node:crypto";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import { processUsageEventKeys$ } from "./credit-usage.service";
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
} from "./managed-usage-record";

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
