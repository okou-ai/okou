import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$ } from "../external/db";
import {
  attributedUsageIdentity,
  managedAttributionQuery,
  managedAttributionWrite,
} from "./managed-usage-attribution";
import { xResourceClockQuery } from "./x-resource-usage-lifecycle";
import {
  type UsageBody,
  XResourceUsageError,
  orderedUsageSources,
  checkObservationTimes,
  xUsageRunQuery,
  billableXUsage,
  usageSourceRetryQuery,
  checkUsageSourceRetries,
  xUsageResourceClaims,
  resourceUsagePublicationSql,
} from "./x-resource-usage-values";

/** Complete batch ownership precedes resource claims; publication is one finite SQL commit. */
export const ingestXResourceUsage$ = command(
  async (
    { set },
    body: UsageBody,
    auth: SandboxAuth,
    signal: AbortSignal,
  ): Promise<void> => {
    const events = orderedUsageSources(body.events);
    const actor = { orgId: auth.orgId, userId: auth.userId, runId: body.runId };
    const db = set(writeDb$);
    const outcome = await settle(
      db.transaction(
        async (tx) => {
          const [run] = await tx.select().from(xUsageRunQuery(actor));
          if (!run) {
            throw new XResourceUsageError(404, "Run not found");
          }
          const [before] = await tx.select().from(xResourceClockQuery());
          checkObservationTimes(before?.at, events, run);
          signal.throwIfAborted();
          const billable = billableXUsage(events, run);
          if (billable.length === 0) {
            return;
          }
          let [attribution] = await tx
            .select()
            .from(managedAttributionQuery(body.runId));
          if (!attribution) {
            const capture = managedAttributionWrite({ actor }, run);
            [attribution] = await tx
              .insert(billingRunAttribution)
              .values(capture.values)
              .onConflictDoUpdate(capture.conflict)
              .returning({
                runId: billingRunAttribution.runId,
                orgId: billingRunAttribution.orgId,
                userId: billingRunAttribution.userId,
                startedAt:
                  sql`${billingRunAttribution.runStartedAt}::text`.mapWith(
                    pgTextDecoder,
                  ),
              });
            if (!attribution) {
              throw new Error("X usage attribution conflicts with history");
            }
          }
          const identity = attributedUsageIdentity({ actor }, run, attribution);
          // Reserve all ordered source identities before any shared resource identity.
          const inserted = await tx
            .insert(usageEvent)
            .values(
              billable.map((event) => {
                return {
                  ...identity,
                  orgId: auth.orgId,
                  userId: auth.userId,
                  kind: event.kind,
                  provider: event.provider,
                  category: event.category,
                  idempotencyKey: event.idempotencyKey,
                  quantity: 0,
                };
              }),
            )
            .onConflictDoNothing({ target: usageEvent.idempotencyKey })
            .returning({ source: usageEvent.idempotencyKey });
          const owned = new Set(
            inserted.map((row) => {
              return row.source;
            }),
          );
          const retries = billable.filter((event) => {
            return !owned.has(event.idempotencyKey);
          });
          if (retries.length > 0) {
            const prior = await tx.select().from(
              usageSourceRetryQuery(
                retries.map((event) => {
                  return event.idempotencyKey;
                }),
              ),
            );
            checkUsageSourceRetries(prior, retries, actor);
          }
          const [reservedAt] = await tx.select().from(xResourceClockQuery());
          checkObservationTimes(reservedAt?.at, events, run);
          const claims = xUsageResourceClaims(billable, owned);
          const reads =
            claims.ordered.length === 0
              ? []
              : await tx
                  .insert(xResourceReads)
                  .values(claims.ordered)
                  .onConflictDoNothing()
                  .returning();
          // A wait across midnight rolls source reservations and resource claims
          // back together. The Run is re-read after the clock sample so a
          // completion committed during this transaction is enforced here.
          const [claimedAt] = await tx.select().from(xResourceClockQuery());
          const [current] = await tx.select().from(xUsageRunQuery(actor));
          if (!current) {
            throw new XResourceUsageError(404, "Run not found");
          }
          checkObservationTimes(claimedAt?.at, events, current);
          // Zero results keep resource claims but no usage receipt, matching existing replay semantics.
          await tx.execute(resourceUsagePublicationSql(claims, reads));
          if (owned.size > 0) {
            await tx
              .update(billingRunAttribution)
              .set({ usageObserved: true })
              .where(
                and(
                  eq(billingRunAttribution.runId, body.runId),
                  eq(billingRunAttribution.usageObserved, false),
                ),
              );
          }
          signal.throwIfAborted();
        },
        { isolationLevel: "read committed" },
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!outcome.ok) {
      // No Run row lock: a Run deleted after the admission read fails the
      // usage insert's FK check once; that is the deterministic not-found.
      throw isForeignKeyViolation(outcome.error)
        ? new XResourceUsageError(404, "Run not found")
        : outcome.error;
    }
  },
);
