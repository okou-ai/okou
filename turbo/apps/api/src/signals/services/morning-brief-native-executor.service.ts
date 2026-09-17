import type { CronExecuteMorningBriefsResponse } from "@okouai/api-contracts/contracts/cron";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  advanceMorningBriefExecutionPhase,
  claimMorningBriefNativeOccurrence,
  clearMorningBriefDeliveryObligation,
  deferMorningBriefNativeOccurrence,
  loadCurrentMembershipGeneration,
  loadDueNativeOwners,
  loadPendingDeliveryOccurrences,
  loadUnresolvedDrains,
  settleMorningBriefNativeOccurrence,
  type MorningBriefNativeOccurrenceRow,
} from "./morning-brief-native-schedule.service";

const log = logger("MorningBriefNativeCron");

/**
 * The native Morning Brief tick.
 *
 * It is the first real consumer of the durable native ownership state: it finds
 * due owners, advances cutover and rollback drains, claims one occurrence per
 * owner under the current fences, runs the real collection → generation →
 * delivery path for that slot, and settles it exactly once.
 *
 * Its boundaries, in the order they matter:
 *
 * - **Bounded.** Finite batches, finite per-owner concurrency and an absolute
 *   tick budget compatible with the hosting request limit. It never sleeps
 *   inside the request and never holds a transaction across a provider call.
 * - **Runless.** No agent Run, sandbox, tool loop, Run-credit admission or
 *   ledger debit. Zero user credits and a full agent-run queue cannot block it.
 * - **Default off.** With `simpleMorningBrief` off, no new native occurrence is
 *   admitted and zero provider calls happen. Already admitted native work keeps
 *   its recorded rollback-drain authority — the switch cannot erase a durable
 *   obligation, only stop new ones.
 *
 * The full protocol is in
 * [native scheduling](../../../../../../docs/morning-brief-native-scheduling.md).
 */

/** Owners examined per tick. Keeps one tick's work inside its budget. */
const DUE_OWNER_BATCH = 25;

/** Pending delivery recoveries examined per tick. */
const DELIVERY_RECOVERY_BATCH = 25;

/** Unresolved drains reported per tick. */
const DRAIN_REPORT_BATCH = 25;

/**
 * The absolute tick budget.
 *
 * The hosting platform terminates a cron request well before this; stopping
 * first means an over-subscribed tick ends with a truthful `budgetExhausted`
 * rather than a mid-slot kill.
 */
const TICK_BUDGET_MS = 45_000;

interface TickCounters {
  examined: number;
  claimed: number;
  settled: number;
  deferred: number;
  deliveriesRecovered: number;
  transitions: number;
  drainsHeld: number;
}

function emptyCounters(): TickCounters {
  return {
    examined: 0,
    claimed: 0,
    settled: 0,
    deferred: 0,
    deliveriesRecovered: 0,
    transitions: 0,
    drainsHeld: 0,
  };
}

/**
 * Whether this member may be admitted to the native implementation right now.
 *
 * The switch is read per user through the normal feature-switch context, so a
 * cohort decision is the switch's own, not a second allowlist.
 */
async function nativeAdmissionAllowed(
  db: Pick<ReadonlyDb, "select">,
  owner: MorningBriefMemberIdentity,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    owner.orgId,
    owner.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.SimpleMorningBrief, context);
}

/**
 * Advance one member's cutover or rollback by at most one legal step.
 *
 * The drain predicate is supplied by the legacy drain reader, which reads the
 * real S7a claim journal, queue events, Runs and shared email intents. An
 * unproven drain holds the phase and records a bounded reason; it never
 * advances because a deadline expired.
 */
const advanceMemberTransition$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefMemberIdentity;
      readonly target: "legacy" | "native";
      readonly drain:
        | { readonly kind: "proven" }
        | { readonly kind: "unresolved"; readonly reason: string };
      readonly at: Date;
    },
  ): Promise<"transitioned" | "held" | "unchanged"> => {
    const db = set(writeDb$);
    return await db.transaction(async (tx) => {
      const result = await advanceMorningBriefExecutionPhase(tx, args.owner, {
        target: args.target,
        drain: args.drain,
        at: args.at,
      });
      if (result.kind === "transitioned") {
        return "transitioned";
      }
      return result.kind === "held" ? "held" : "unchanged";
    });
  },
);

/**
 * Execute one claimed slot.
 *
 * Returns the settlement the caller must apply. The provider work happens
 * outside any transaction; only the reservation, the accepted result and the
 * settlement are transactional.
 */
export type NativeSlotExecution =
  | { readonly kind: "empty-skip" }
  | { readonly kind: "model-skip" }
  | { readonly kind: "delivered"; readonly generationAttemptId: string }
  | { readonly kind: "collection-failed" }
  | { readonly kind: "generation-failed"; readonly generationAttemptId: string }
  | {
      readonly kind: "generation-unknown";
      readonly generationAttemptId: string;
    }
  | { readonly kind: "defer"; readonly reason: string }
  | { readonly kind: "revoked" };

/**
 * The per-slot execution the tick runs.
 *
 * It is injected so the cron composition, its fences and its settlement can be
 * exercised against a real provider double without the tick reaching for a
 * preview HTTP route or seeding a synthetic result.
 */
export interface NativeSlotExecutor {
  readonly execute: (
    owner: MorningBriefMemberIdentity,
    occurrence: MorningBriefNativeOccurrenceRow,
    signal: AbortSignal,
  ) => Promise<NativeSlotExecution>;
}

function outcomeFor(execution: NativeSlotExecution): {
  readonly outcome: Parameters<
    typeof settleMorningBriefNativeOccurrence
  >[2]["outcome"];
  readonly deliveryPending: boolean;
} {
  switch (execution.kind) {
    case "empty-skip":
      return { outcome: "empty-skip", deliveryPending: false };
    case "model-skip":
      return { outcome: "model-skip", deliveryPending: false };
    case "delivered":
      // The accepted result's delivery work is discoverable before the slot is
      // marked settled, so the next occurrence may become due while this
      // result's delivery recovery is still pending.
      return { outcome: "delivered", deliveryPending: true };
    case "collection-failed":
      return { outcome: "collection-failed", deliveryPending: false };
    case "generation-failed":
      return { outcome: "generation-failed", deliveryPending: false };
    case "generation-unknown":
      return { outcome: "generation-unknown", deliveryPending: false };
    case "revoked":
      return { outcome: "revoked", deliveryPending: false };
    case "defer":
      return { outcome: "not-configured", deliveryPending: false };
  }
}

/**
 * Resolve one pending delivery recovery.
 *
 * The consumer resolves the durable receipt by the stable native occurrence
 * identity first and does not require the S5 result to still be present: a Chat
 * receipt committed before a crash stays delivered after the result expires,
 * and its shared-outbox email recovery is preserved. Only when no committed
 * receipt exists may the same saved result be retried under current authority.
 * Neither path regenerates, and neither settles the schedule a second time.
 */
export interface NativeDeliveryRecovery {
  readonly resolve: (
    owner: MorningBriefMemberIdentity,
    occurrence: MorningBriefNativeOccurrenceRow,
    signal: AbortSignal,
  ) => Promise<"delivered" | "pending" | "terminal-failure">;
}

/** Everything the tick needs from outside itself. */
export interface NativeTickDependencies {
  readonly executor: NativeSlotExecutor;
  readonly delivery: NativeDeliveryRecovery;
  /**
   * The real legacy drain predicate for one member.
   *
   * Supplied by the caller because proving it reads the actual S7a schedule
   * claim journal, its queue/Run bindings and the shared email intents.
   */
  readonly legacyDrain: (
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ) => Promise<
    | { readonly kind: "proven" }
    | { readonly kind: "unresolved"; readonly reason: string }
  >;
}

/**
 * Run one bounded native Morning Brief tick.
 *
 * Every step re-reads the fences it depends on. A member whose choice, epoch or
 * membership changed between discovery and execution is simply not admitted,
 * which is why a disabled or revoked owner cannot reach the provider.
 */
export const executeNativeMorningBriefTick$ = command(
  async (
    { set },
    deps: NativeTickDependencies,
    signal: AbortSignal,
  ): Promise<CronExecuteMorningBriefsResponse> => {
    const db = set(writeDb$);
    const counters = emptyCounters();
    const startedAt = nowDate();
    const overBudget = (): boolean => {
      return nowDate().getTime() - startedAt.getTime() >= TICK_BUDGET_MS;
    };

    // 1. Delivery recovery first. A pending receipt is already settled work, so
    //    resolving it never competes with, or wedges, the future scheduler.
    const pending = await loadPendingDeliveryOccurrences(db, {
      limit: DELIVERY_RECOVERY_BATCH,
    });
    for (const occurrence of pending) {
      if (overBudget()) {
        return { ...counters, budgetExhausted: true };
      }
      signal.throwIfAborted();
      const owner = { orgId: occurrence.orgId, userId: occurrence.userId };
      const resolution = await deps.delivery.resolve(owner, occurrence, signal);
      if (resolution === "pending") {
        continue;
      }
      await db.transaction(async (tx) => {
        await clearMorningBriefDeliveryObligation(tx, owner, {
          scheduledFor: occurrence.scheduledFor,
          at: nowDate(),
        });
      });
      counters.deliveriesRecovered += 1;
      if (resolution === "terminal-failure") {
        log.warn("Morning Brief delivery exhausted its retention", {
          orgId: occurrence.orgId,
          scheduledFor: occurrence.scheduledFor.toISOString(),
        });
      }
    }

    // 2. Due native owners.
    const due = await loadDueNativeOwners(db, {
      now: nowDate(),
      limit: DUE_OWNER_BATCH,
    });
    for (const schedule of due) {
      if (overBudget()) {
        return { ...counters, budgetExhausted: true };
      }
      signal.throwIfAborted();
      counters.examined += 1;
      const owner = { orgId: schedule.orgId, userId: schedule.userId };

      // The switch gates new admission only. It never rewrites a durable
      // obligation, and a fresh default-off owner makes zero provider calls.
      if (!(await nativeAdmissionAllowed(db, owner))) {
        const drain = await deps.legacyDrain(owner, signal);
        const outcome = await set(advanceMemberTransition$, {
          owner,
          target: "legacy",
          drain,
          at: nowDate(),
        });
        if (outcome === "transitioned") {
          counters.transitions += 1;
        } else if (outcome === "held") {
          counters.drainsHeld += 1;
        }
        continue;
      }

      // Fresh membership generation, read at the admission boundary.
      const membershipId = await loadCurrentMembershipGeneration(db, owner);
      if (membershipId === null) {
        continue;
      }

      const leaseToken = crypto.randomUUID();
      const claim = await db.transaction(async (tx) => {
        return await claimMorningBriefNativeOccurrence(tx, owner, {
          now: nowDate(),
          leaseToken,
          membershipId,
        });
      });
      if (claim.kind !== "claimed") {
        continue;
      }
      counters.claimed += 1;

      // The provider work runs outside every transaction.
      const execution = await deps.executor.execute(
        owner,
        claim.occurrence,
        signal,
      );

      if (execution.kind === "defer") {
        const deferral = await db.transaction(async (tx) => {
          return await deferMorningBriefNativeOccurrence(tx, owner, {
            scheduledFor: claim.occurrence.scheduledFor,
            reason: execution.reason,
            at: nowDate(),
          });
        });
        if (deferral.kind === "deferred") {
          counters.deferred += 1;
          continue;
        }
        // Exhausted: settle as not configured and schedule the next occurrence
        // rather than disabling the member's Morning Brief.
      }

      const { outcome, deliveryPending } = outcomeFor(execution);
      const settlement = await db.transaction(async (tx) => {
        return await settleMorningBriefNativeOccurrence(tx, owner, {
          scheduledFor: claim.occurrence.scheduledFor,
          outcome,
          deliveryPending,
          generationAttemptId:
            "generationAttemptId" in execution
              ? execution.generationAttemptId
              : undefined,
          at: nowDate(),
        });
      });
      if (settlement.kind === "settled") {
        counters.settled += 1;
      }
    }

    // 3. Cutover progress for members the switch now selects but who are still
    //    on legacy or mid-drain.
    const held = await loadUnresolvedDrains(db, {
      now: nowDate(),
      limit: DRAIN_REPORT_BATCH,
    });
    for (const row of held) {
      if (overBudget()) {
        return { ...counters, budgetExhausted: true };
      }
      signal.throwIfAborted();
      const owner = { orgId: row.orgId, userId: row.userId };
      const drain = await deps.legacyDrain(owner, signal);
      const outcome = await set(advanceMemberTransition$, {
        owner,
        target: row.target,
        drain,
        at: nowDate(),
      });
      if (outcome === "transitioned") {
        counters.transitions += 1;
      } else if (outcome === "held") {
        counters.drainsHeld += 1;
        log.warn("Morning Brief drain still unresolved", {
          orgId: row.orgId,
          phase: row.phase,
          reason: drain.kind === "unresolved" ? drain.reason : "unknown",
        });
      }
    }

    return { ...counters, budgetExhausted: false };
  },
);
