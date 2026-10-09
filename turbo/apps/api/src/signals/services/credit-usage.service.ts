import { command } from "ccstate";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { and, asc, eq } from "drizzle-orm";
import { recordBillingOperationTimings } from "../external/sandbox-op-log";
import { writeDb$ } from "../external/db";
import { logger } from "../../lib/log";
import { safeSync, tapError } from "../utils";
import { maybeEmitRunUsageEvent$ } from "./chat-usage-event.service";
import { enqueueCreditLowBalanceAlert$ } from "./credit-low-balance-alert.service";
import { triggerAutoRecharge$ } from "./credit-recharge.service";
import { USAGE_SETTLEMENT_BATCH_SIZE } from "./credit-usage-batch";
import { settleOrgUsage$ } from "./credit-usage-settlement.service";
import type { ProcessOrgUsageEventsResult } from "./credit-usage-pricing";
const L = logger("CreditUsage");

export const completeProcessedOrgUsage$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly result: ProcessOrgUsageEventsResult;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const { orgId, result } = args;
    const { sharedCreditsCharged, runIds, lowBalanceAlert } = result;
    signal.throwIfAborted();
    // Postcommit only: a rollback is not reported as a completed settlement.
    // No org, user, run or event ID is sent with these timing operations.
    if (result.work.pendingEvents > 0) {
      // The ledger has committed. Best-effort telemetry must not turn its
      // receipt into a failed response; safeSync still propagates cancellation.
      safeSync(() => {
        const work = result.work;
        const timingScope =
          work.transactionDurationMs === undefined ? "inline" : "standalone";
        recordBillingOperationTimings([
          {
            actionType: "api_billing_settlement_work",
            durationMs: work.settlementWorkMs,
            success: true,
            dimensions: {
              timing_scope: timingScope,
              pending_events: work.pendingEvents,
              pricing_rows: work.pricingRows,
              compaction_lock_wait_ms: work.lockWaitMs,
              // These SQL operations now run in shared batches. Report the
              // measured owner duration, never invented zero phase timings.
              statement_grouping: "command_local_batch",
              affected_users: work.affectedUsers,
              grant_rows: work.grantRows,
              expired_rows: work.expiredRows,
              expiry_rows: work.expiryRows,
            },
          },
          {
            actionType: "api_billing_settlement_compaction_lock_wait",
            durationMs: work.lockWaitMs,
            success: true,
            dimensions: { timing_scope: timingScope },
          },
          ...(work.transactionDurationMs === undefined
            ? []
            : [
                {
                  actionType: "api_billing_settlement_transaction",
                  durationMs: work.transactionDurationMs,
                  success: true,
                  dimensions: { timing_scope: "standalone" },
                },
              ]),
        ]);
      });
    }

    if (sharedCreditsCharged > 0) {
      // Auto-recharge runs OUTSIDE the deduction transaction (Stripe
      // can't be transactional with DB). triggerAutoRecharge$ catches
      // its own errors (clearPendingFlag in catch); the await here is
      // bounded by the route handler's outer waitUntil envelope.
      await set(triggerAutoRecharge$, orgId, signal);
      signal.throwIfAborted();
    }

    if (lowBalanceAlert) {
      await tapError(
        set(enqueueCreditLowBalanceAlert$, lowBalanceAlert, signal),
        (error) => {
          L.error("Failed to enqueue low-credit alert after usage processing", {
            orgId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    for (const runId of runIds) {
      await tapError(set(maybeEmitRunUsageEvent$, runId, signal), (error) => {
        L.error("Failed to emit chat usage message after usage processing", {
          orgId,
          runId,
          error,
        });
      });
      signal.throwIfAborted();
    }
  },
);

/**
 * Atomically settle pending usage using member credit packs and shared credits,
 * before running recharge, notification, and usage-event delivery effects.
 * Effects run after COMMIT so callers never retain ledger locks during I/O.
 */
export const processUsageEventKeys$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly idempotencyKeys: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<void> => {
    for (
      let offset = 0;
      offset < args.idempotencyKeys.length;
      offset += USAGE_SETTLEMENT_BATCH_SIZE
    ) {
      const idempotencyKeys = args.idempotencyKeys.slice(
        offset,
        offset + USAGE_SETTLEMENT_BATCH_SIZE,
      );
      const result = await set(
        settleOrgUsage$,
        { orgId: args.orgId, idempotencyKeys },
        signal,
      );
      if (result) {
        await set(
          completeProcessedOrgUsage$,
          { orgId: args.orgId, result },
          signal,
        );
      }
    }
  },
);

/**
 * Background catch-up: one read of the pending identities, then committed
 * batches of them, never inside one transaction. A batch whose snapshot was
 * rejected stays pending for the next settlement cycle; nothing is re-read or
 * re-run here.
 */
export const processOrgUsageEvents$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const pending = await set(writeDb$)
      .select({ key: usageEvent.idempotencyKey })
      .from(usageEvent)
      .where(and(eq(usageEvent.orgId, orgId), eq(usageEvent.status, "pending")))
      .orderBy(asc(usageEvent.id));
    signal.throwIfAborted();
    await set(
      processUsageEventKeys$,
      {
        orgId,
        idempotencyKeys: pending.map((row) => {
          return row.key;
        }),
      },
      signal,
    );
  },
);
