import type { CronExecuteMorningBriefsResponse } from "@okouai/api-contracts/contracts/cron";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type ReadonlyDb } from "../external/db";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { currentMembershipId$ } from "./morning-brief-collection-executor.service";
import {
  advanceMorningBriefExecutionPhase,
  claimMorningBriefNativeOccurrence,
  closeRecoveredMorningBriefDelivery,
  deferMorningBriefNativeOccurrence,
  loadBootstrapCandidates,
  loadDueNativeOwners,
  loadPendingDeliveryOccurrences,
  loadResumableOccurrences,
  lockMorningBriefNativeSchedule,
  loadTransitionCandidates,
  materializeMorningBriefNativeSchedule,
  resumeMorningBriefNativeOccurrence,
  settleMorningBriefNativeOccurrence,
  type MorningBriefNativeClaim,
  type MorningBriefNativeOccurrenceRow,
} from "./morning-brief-native-schedule.service";
import type {
  MorningBriefExecutionPhase,
  MorningBriefExecutionTarget,
} from "@okouai/db/schema/morning-brief-native-schedule";

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

/**
 * How far the bootstrap scan looks for materializable owners.
 *
 * Wider than the work budget on purpose: candidates whose membership no longer
 * resolves cannot be materialized, and a window the size of the budget would
 * let a backlog of them consume every slot. The loop still stops at
 * {@link DUE_OWNER_BATCH} materializations or the tick deadline.
 */
const BOOTSTRAP_SCAN_WINDOW = 200;

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
  materialized: number;
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
    materialized: 0,
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
      readonly drain: DrainVerdict;
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
    case "empty-skip": {
      return { outcome: "empty-skip", deliveryPending: false };
    }
    case "model-skip": {
      return { outcome: "model-skip", deliveryPending: false };
    }
    case "delivered": {
      // The accepted result's delivery work is discoverable before the slot is
      // marked settled, so the next occurrence may become due while this
      // result's delivery recovery is still pending.
      return { outcome: "delivered", deliveryPending: true };
    }
    case "collection-failed": {
      return { outcome: "collection-failed", deliveryPending: false };
    }
    case "generation-failed": {
      return { outcome: "generation-failed", deliveryPending: false };
    }
    case "generation-unknown": {
      return { outcome: "generation-unknown", deliveryPending: false };
    }
    case "revoked": {
      return { outcome: "revoked", deliveryPending: false };
    }
    case "defer": {
      return { outcome: "not-configured", deliveryPending: false };
    }
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
export type NativeDeliveryRecoveryResolution =
  | { readonly kind: "pending" }
  | {
      readonly kind: "settle";
      readonly outcome: Parameters<
        typeof settleMorningBriefNativeOccurrence
      >[2]["outcome"];
    };

export interface NativeDeliveryRecovery {
  readonly resolve: (
    owner: MorningBriefMemberIdentity,
    occurrence: MorningBriefNativeOccurrenceRow,
    signal: AbortSignal,
  ) => Promise<NativeDeliveryRecoveryResolution>;
  /**
   * Recheck S6's durable receipt after the schedule row serializes this close.
   *
   * An already-admitted S6 transaction holds that same schedule lock until its
   * receipt commits. Recovery can therefore decide from the post-wait truth
   * instead of settling from a receipt read that became stale while it waited.
   */
  readonly hasCommittedReceipt: (
    db: Pick<ReadonlyDb, "select">,
    owner: MorningBriefMemberIdentity,
    occurrence: MorningBriefNativeOccurrenceRow,
  ) => Promise<boolean>;
}

/** Everything the tick needs from outside itself. */
export interface NativeTickDependencies {
  /** Test-route ownership scope; production cron intentionally leaves it absent. */
  readonly scope?: MorningBriefMemberIdentity;
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
  ) => Promise<DrainVerdict>;
  /**
   * The rollback drain predicate.
   *
   * Legacy's journal says nothing about native work, so the two directions need
   * different evidence and must not share one predicate.
   */
  readonly nativeDrain: (
    owner: MorningBriefMemberIdentity,
    signal: AbortSignal,
  ) => Promise<DrainVerdict>;
}

export type DrainVerdict =
  | { readonly kind: "proven" }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * Resolve every pending delivery obligation this tick can reach.
 *
 * Returns true when the budget ran out mid-pass. The slots involved are already
 * settled, so this never competes with, or wedges, the future scheduler.
 */
const runDeliveryRecoveryPass$ = command(
  async (
    { set },
    args: {
      readonly deps: NativeTickDependencies;
      readonly counters: TickCounters;
      readonly overBudget: () => boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { deps, counters } = args;
    for (const occurrence of await loadPendingDeliveryOccurrences(db, {
      limit: DELIVERY_RECOVERY_BATCH,
      owner: deps.scope,
    })) {
      if (args.overBudget()) {
        return true;
      }
      const owner = { orgId: occurrence.orgId, userId: occurrence.userId };
      const resolution = await deps.delivery.resolve(owner, occurrence, signal);
      if (resolution.kind === "pending") {
        continue;
      }
      const generationAttemptId = occurrence.generationAttemptId;
      if (generationAttemptId === null) {
        // The discovery query requires this value, but retain the guard at the
        // mutation boundary rather than widening a malformed obligation.
        continue;
      }
      const closure = await db.transaction(async (tx) => {
        // S6 holds this same row until its delivery receipt commits. Take it
        // before the final receipt read so a delivery that was in flight during
        // `resolve` wins over that pre-wait snapshot.
        if ((await lockMorningBriefNativeSchedule(tx, owner)) === undefined) {
          return {
            status: "absent" as const,
            effectiveOutcome: resolution.outcome,
          };
        }
        const receiptCommitted = await deps.delivery.hasCommittedReceipt(
          tx,
          owner,
          occurrence,
        );
        const effectiveOutcome = receiptCommitted
          ? "delivered"
          : resolution.outcome;
        const status = await closeRecoveredMorningBriefDelivery(tx, owner, {
          scheduledFor: occurrence.scheduledFor,
          expectedEpoch: occurrence.ownerEpoch,
          expectedGenerationAttemptId: generationAttemptId,
          leaseToken: occurrence.leaseToken,
          // A slot that bound its attempt but crashed before its own settlement
          // still owes that settlement; one already settled only owes the clear.
          settleAs: occurrence.settledAt === null ? effectiveOutcome : null,
          at: nowDate(),
        });
        return { status, effectiveOutcome };
      });
      signal.throwIfAborted();
      if (closure.status !== "closed") {
        // Reclaimed or revoked between the receipt read and this mutation. The
        // new owner keeps its own obligation; nothing is cleared behind it.
        continue;
      }
      counters.deliveriesRecovered += 1;
      if (closure.effectiveOutcome === "generation-unknown") {
        log.warn("Morning Brief generation recovery resolved unknown", {
          orgId: occurrence.orgId,
          scheduledFor: occurrence.scheduledFor.toISOString(),
        });
      }
    }
    return false;
  },
);
/**
 * Advance cutover and rollback for every member whose ownership may need to
 * move. The target is the switch's CURRENT intent, re-read per member, not the
 * intent persisted by an older flip.
 */
const runTransitionPass$ = command(
  async (
    { set },
    args: {
      readonly deps: NativeTickDependencies;
      readonly counters: TickCounters;
      readonly overBudget: () => boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    for (const row of await loadTransitionCandidates(db, {
      now: nowDate(),
      limit: DRAIN_REPORT_BATCH,
      owner: args.deps.scope,
    })) {
      if (args.overBudget()) {
        return true;
      }
      const owner = { orgId: row.orgId, userId: row.userId };
      const target: MorningBriefExecutionTarget = (await nativeAdmissionAllowed(
        db,
        owner,
      ))
        ? "native"
        : "legacy";
      await set(
        advanceOneTransition$,
        {
          deps: args.deps,
          owner,
          target,
          phase: row.phase,
          counters: args.counters,
        },
        signal,
      );
      signal.throwIfAborted();
    }
    return false;
  },
);
/**
 * Resume slots a previous tick left unsettled.
 *
 * The claim already took the schedule obligation away, so nothing else would
 * rediscover these. Returns true when the tick budget ran out mid-pass.
 */
const runResumePass$ = command(
  async (
    { set },
    args: {
      readonly deps: NativeTickDependencies;
      readonly counters: TickCounters;
      readonly overBudget: () => boolean;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const { deps, counters } = args;
    const overBudget = args.overBudget;
    // 2. Resume slots a previous tick left unsettled. The claim already took
    //    the schedule obligation, so nothing else would rediscover them.
    for (const stale of await loadResumableOccurrences(db, {
      now: nowDate(),
      limit: DUE_OWNER_BATCH,
      owner: deps.scope,
    })) {
      if (overBudget()) {
        return true;
      }
      const owner = { orgId: stale.orgId, userId: stale.userId };
      // Deliberately not gated on the implementation switch. Switching off must
      // stop *new* admission, which the due-owner claim enforces; an obligation
      // this scheduler already recorded still has to be reconciled, or it
      // wedges the rollback drain that is waiting on that same unsettled row.
      const membershipId = await set(currentMembershipId$, owner, signal);
      signal.throwIfAborted();
      if (membershipId === null) {
        continue;
      }
      const leaseToken = crypto.randomUUID();
      const resumed = await db.transaction(async (tx) => {
        return await resumeMorningBriefNativeOccurrence(tx, owner, {
          scheduledFor: stale.scheduledFor,
          now: nowDate(),
          leaseToken,
          membershipId,
        });
      });
      signal.throwIfAborted();
      if (resumed.kind !== "claimed") {
        continue;
      }

      // Reconciliation, not execution. A member the switch no longer selects, or
      // one already rolling back, must not have this slot run: the correct
      // action is to close the recorded obligation under the current authority
      // so the drain can finish. Nothing it already produced is erased — a slot
      // that bound an attempt is not resumable at all and stays with the
      // receipt consumer.
      const suppress =
        resumed.schedule.phase === "rollback-draining" ||
        !(await nativeAdmissionAllowed(db, owner));
      signal.throwIfAborted();
      if (suppress) {
        const token = resumed.occurrence.leaseToken;
        if (token !== null) {
          await db.transaction(async (tx) => {
            await settleMorningBriefNativeOccurrence(tx, owner, {
              scheduledFor: resumed.occurrence.scheduledFor,
              outcome: "revoked",
              deliveryPending: false,
              expectedEpoch: resumed.occurrence.ownerEpoch,
              leaseToken: token,
              at: nowDate(),
            });
          });
          signal.throwIfAborted();
          counters.settled += 1;
        }
        continue;
      }

      counters.claimed += 1;
      await set(runOneSlot$, { deps, claim: resumed, counters }, signal);
      signal.throwIfAborted();
    }

    return false;
  },
);
/** One slot's work: claim/resume, execute outside a transaction, settle once. */
const runOneSlot$ = command(
  async (
    { set },
    args: {
      readonly deps: NativeTickDependencies;
      readonly claim: Extract<MorningBriefNativeClaim, { kind: "claimed" }>;
      readonly counters: TickCounters;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const { deps, claim, counters } = args;
    const owner = {
      orgId: claim.occurrence.orgId,
      userId: claim.occurrence.userId,
    };
    const leaseToken = claim.occurrence.leaseToken;
    const expectedEpoch = claim.occurrence.ownerEpoch;
    if (leaseToken === null) {
      return;
    }

    // The provider work runs outside every transaction, under the tick's own
    // deadline so a slow source cannot outlive the request that admitted it.
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
          expectedEpoch,
          leaseToken,
          at: nowDate(),
        });
      });
      signal.throwIfAborted();
      if (deferral.kind === "deferred") {
        counters.deferred += 1;
        return;
      }
      if (deferral.kind === "stale-claimant") {
        // Reclaimed or revoked while this worker was away. Its observation is
        // still evidence, but it has no authority to schedule.
        return;
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
        expectedEpoch,
        leaseToken,
        at: nowDate(),
      });
    });
    signal.throwIfAborted();
    if (settlement.kind === "settled") {
      counters.settled += 1;
    }
  },
);
/** Advance one member's transition toward the switch's current intent. */
const advanceOneTransition$ = command(
  async (
    { set },
    args: {
      readonly deps: NativeTickDependencies;
      readonly owner: MorningBriefMemberIdentity;
      readonly target: MorningBriefExecutionTarget;
      /** The phase actually recorded on the row this tick read. */
      readonly phase: MorningBriefExecutionPhase;
      readonly counters: TickCounters;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const deps = args.deps;
    // The drain evidence must match the **actual phase edge**, not the target.
    // A rollback that reverses back to native still has native work to reconcile,
    // and a cutover that reverses back to legacy has only legacy work: choosing
    // by target alone hands one edge the other side's proof.
    const drain =
      args.phase === "native" || args.phase === "rollback-draining"
        ? await deps.nativeDrain(args.owner, signal)
        : await deps.legacyDrain(args.owner, signal);
    signal.throwIfAborted();
    const outcome = await set(advanceMemberTransition$, {
      owner: args.owner,
      target: args.target,
      drain,
      at: nowDate(),
    });
    signal.throwIfAborted();
    if (outcome === "transitioned") {
      args.counters.transitions += 1;
      return;
    }
    if (outcome === "held") {
      args.counters.drainsHeld += 1;
      log.warn("Morning Brief drain still unresolved", {
        orgId: args.owner.orgId,
        target: args.target,
        reason: drain.kind === "unresolved" ? drain.reason : "unknown",
      });
    }
  },
);
/**
 * Run one bounded native Morning Brief tick.
 *
 * Every step re-reads the fences it depends on. A member whose choice, epoch or
 * membership changed between discovery and execution is simply not admitted,
 * which is why a disabled or revoked owner cannot reach the provider.
 *
 * The tick composes an absolute deadline into the signal it passes downstream,
 * so a long provider read is cancelled by the same budget that stops the loop
 * rather than being noticed only after it returns.
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
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(TICK_BUDGET_MS),
    ]);
    const overBudget = (): boolean => {
      return (
        deadline.aborted ||
        nowDate().getTime() - startedAt.getTime() >= TICK_BUDGET_MS
      );
    };
    const exhausted = (): CronExecuteMorningBriefsResponse => {
      return { ...counters, budgetExhausted: true };
    };

    // 0. Bootstrap. Bounded, idempotent materialization of the members whose
    //    installed brief has no durable native row yet. It only ever writes a
    //    `legacy`-phase row, so it is never a cutover on its own.
    for (const owner of await loadBootstrapCandidates(db, {
      limit: BOOTSTRAP_SCAN_WINDOW,
      owner: deps.scope,
    })) {
      if (overBudget() || counters.materialized >= DUE_OWNER_BATCH) {
        break;
      }
      const membershipId = await set(currentMembershipId$, owner, deadline);
      signal.throwIfAborted();
      if (membershipId === null) {
        // The member no longer resolves, so nothing can be materialized for
        // them. Skipping without consuming the work budget is what keeps a
        // backlog of such owners from starving members that can still migrate.
        continue;
      }
      await db.transaction(async (tx) => {
        await materializeMorningBriefNativeSchedule(tx, owner, {
          membershipId,
          at: nowDate(),
        });
      });
      signal.throwIfAborted();
      counters.materialized += 1;
    }

    if (
      await set(
        runDeliveryRecoveryPass$,
        { deps, counters, overBudget },
        deadline,
      )
    ) {
      return exhausted();
    }

    if (await set(runResumePass$, { deps, counters, overBudget }, deadline)) {
      return exhausted();
    }

    // 3. Due native owners.
    for (const schedule of await loadDueNativeOwners(db, {
      now: nowDate(),
      limit: DUE_OWNER_BATCH,
      owner: deps.scope,
    })) {
      if (overBudget()) {
        return exhausted();
      }
      counters.examined += 1;
      const owner = { orgId: schedule.orgId, userId: schedule.userId };

      // The switch gates new admission only. It never rewrites a durable
      // obligation, and a fresh default-off owner makes zero provider calls.
      if (!(await nativeAdmissionAllowed(db, owner))) {
        await set(
          advanceOneTransition$,
          { deps, owner, target: "legacy", phase: schedule.phase, counters },
          deadline,
        );
        signal.throwIfAborted();
        continue;
      }

      // Fresh membership generation, read at the admission boundary.
      const membershipId = await set(currentMembershipId$, owner, deadline);
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      if (claim.kind !== "claimed") {
        continue;
      }
      counters.claimed += 1;
      await set(runOneSlot$, { deps, claim, counters }, deadline);
      signal.throwIfAborted();
    }

    if (
      await set(runTransitionPass$, { deps, counters, overBudget }, deadline)
    ) {
      return exhausted();
    }

    return { ...counters, budgetExhausted: false };
  },
);
