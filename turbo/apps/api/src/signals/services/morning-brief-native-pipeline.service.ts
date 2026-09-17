import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { deliverMorningBriefResult$ } from "./morning-brief-delivery.service";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import type { MorningBriefGenerationView } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";

import {
  executeMorningBriefGeneration$,
  type MorningBriefGenerationExecution,
} from "./morning-brief-generation-executor.service";
import type {
  NativeDeliveryRecovery,
  NativeSlotExecution,
  NativeSlotExecutor,
  NativeTickDependencies,
} from "./morning-brief-native-executor.service";
import {
  readMorningBriefNativeSchedule,
  type MorningBriefNativeOccurrenceRow,
  type MorningBriefNativeScheduleRow,
} from "./morning-brief-native-schedule.service";

const log = logger("MorningBriefNativePipeline");

/**
 * The production wiring of the native Morning Brief tick.
 *
 * The tick takes its per-slot execution, delivery recovery and drain predicates
 * as dependencies so a test can substitute an external boundary double without
 * substituting the scheduler. This module is the one place that binds them to
 * the real S5 generation engine, the real S6 delivery engine and the real S7a
 * legacy journal. It introduces no second provider, queue or authorization
 * engine and never invokes a preview HTTP route.
 */

export type MorningBriefDrainVerdict =
  | { readonly kind: "proven" }
  | { readonly kind: "unresolved"; readonly reason: string };

/**
 * Prove — or refuse to prove — that the **legacy** path has drained for one
 * member, so the forward cutover may transfer its scheduling obligation.
 *
 * The evidence is the real S7a schedule-claim journal, which records the exact
 * scheduled anchor with its queue-event and Run bindings and settles each claim
 * once. The rules this encodes:
 *
 * - An **unsettled** journalled claim is reachable work. It keeps the drain
 *   unresolved; it is never treated as finished because a lease or TTL lapsed.
 * - A journalled claim that is settled but still carries a **queue binding in
 *   the `queued` disposition** has a launch that was never consumed, and a
 *   claim still bound to a **non-terminal Run** has a callback that can still
 *   write. Both keep the drain unresolved.
 * - A member with **no journal rows at all** has unknown history: the journal
 *   only starts recording at S7a's deployment, so earlier work has no
 *   recoverable scheduled identity. It must not be reconstructed from
 *   `firedAt`, a Run's context or an automation title, so this reports
 *   `legacy-history-unjournalled` and holds.
 *
 * It deliberately does not accept `automation.enabled = false`, an empty
 * outbox, a completed agent status or one expired TTL as proof.
 */
export async function proveLegacyMorningBriefDrain(
  db: ReadonlyDb,
  owner: MorningBriefMemberIdentity,
  schedule: MorningBriefNativeScheduleRow | undefined,
): Promise<MorningBriefDrainVerdict> {
  if (schedule === undefined || schedule.legacyAutomationId === null) {
    // Nothing legacy was ever selected for this member, so there is no old
    // producer, callback or mail work that could still be reachable.
    return { kind: "proven" };
  }

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unsettled: sql<number>`count(*) FILTER (WHERE ${morningBriefScheduleClaims.settlement} = 'unsettled')::int`,
      queued: sql<number>`count(*) FILTER (WHERE ${morningBriefScheduleClaims.queueDisposition} = 'queued' AND ${morningBriefScheduleClaims.queueEventId} IS NOT NULL)::int`,
      liveRuns: sql<number>`count(*) FILTER (WHERE ${morningBriefScheduleClaims.runId} IS NOT NULL AND ${morningBriefScheduleClaims.settlement} = 'unsettled')::int`,
    })
    .from(morningBriefScheduleClaims)
    .where(
      and(
        eq(
          morningBriefScheduleClaims.automationId,
          schedule.legacyAutomationId,
        ),
        eq(morningBriefScheduleClaims.orgId, owner.orgId),
        eq(morningBriefScheduleClaims.ownerUserId, owner.userId),
      ),
    );

  if (counts === undefined || counts.total === 0) {
    // No journalled claim exists. That is unknown history rather than a proven
    // drain *unless* the automation has never launched a Run at all: an
    // automation with no `last_run_id` has produced no legacy Run, no result
    // callback and no result email, so there is nothing reachable to drain.
    // Anything else keeps the bounded unresolved reason rather than inventing
    // an anchor from `firedAt`, a Run's context or a title.
    const [legacy] = await db
      .select({ lastRunId: workflowAutomations.lastRunId })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, schedule.legacyAutomationId))
      .limit(1);
    return legacy !== undefined && legacy.lastRunId === null
      ? { kind: "proven" }
      : { kind: "unresolved", reason: "legacy-history-unjournalled" };
  }
  if (counts.unsettled > 0) {
    return { kind: "unresolved", reason: "legacy-claim-unsettled" };
  }
  if (counts.queued > 0) {
    return { kind: "unresolved", reason: "legacy-launch-unconsumed" };
  }
  if (counts.liveRuns > 0) {
    return { kind: "unresolved", reason: "legacy-run-callback-reachable" };
  }
  return { kind: "proven" };
}

/**
 * Prove — or refuse to prove — that the **native** path has drained, so a
 * rollback may hand the obligation back to legacy.
 *
 * This is the other direction and needs different evidence: legacy's journal
 * says nothing about native work. Reachable native work is an unsettled
 * occurrence — a claim whose lease may still return, a deferral that is still
 * due, or a reserved generation whose provider outcome is still unknown — and
 * an accepted result whose delivery obligation is still pending. Either keeps
 * the rollback draining rather than opening legacy alongside it.
 */
export async function proveNativeMorningBriefDrain(
  db: ReadonlyDb,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefDrainVerdict> {
  const [counts] = await db
    .select({
      unsettled: sql<number>`count(*) FILTER (WHERE settled_at IS NULL)::int`,
      pendingDelivery: sql<number>`count(*) FILTER (WHERE delivery_pending)::int`,
    })
    .from(sql`morning_brief_native_occurrences`)
    .where(sql`org_id = ${owner.orgId} AND user_id = ${owner.userId}`);

  if (counts === undefined) {
    return { kind: "proven" };
  }
  if (counts.unsettled > 0) {
    return { kind: "unresolved", reason: "native-occurrence-unsettled" };
  }
  if (counts.pendingDelivery > 0) {
    return { kind: "unresolved", reason: "native-delivery-pending" };
  }
  return { kind: "proven" };
}

/**
 * Map one real S5 generation execution onto the settlement matrix.
 *
 * Every branch is a distinct durable outcome: a healthy empty read can never be
 * read back as a failure, a known terminal generation failure can never be read
 * back as a healthy skip, and an invocation whose outcome stayed unknown is
 * never reported as zero spend or retried with a second POST.
 */
export function nativeSettlementOfGeneration(
  execution: MorningBriefGenerationExecution,
): NativeSlotExecution {
  switch (execution.kind) {
    case "not-executed": {
      // Nothing was reserved and nothing was contacted, so this is the bounded
      // pre-reservation configuration branch.
      return { kind: "defer", reason: "generation-not-admitted" };
    }
    case "invalid-anchor":
    case "conflict": {
      return { kind: "defer", reason: `generation-${execution.kind}` };
    }
    case "collection-failed": {
      return { kind: "collection-failed" };
    }
    case "collection-completed-without-generation": {
      // The collection finished and held nothing worth a model request.
      return { kind: "empty-skip" };
    }
    case "generated":
    case "already-generated": {
      return mapGenerationState(execution.generation);
    }
  }
}

function mapGenerationState(
  generation: MorningBriefGenerationView,
): NativeSlotExecution {
  switch (generation.state) {
    case "skipped_empty": {
      return { kind: "empty-skip" };
    }
    case "skipped_incomplete": {
      // Honest incompleteness, never a healthy empty day.
      return { kind: "collection-failed" };
    }
    case "succeeded": {
      return generation.result?.decision === "deliver"
        ? { kind: "delivered", generationAttemptId: generation.attemptId }
        : { kind: "model-skip" };
    }
    case "invocation_outcome_unknown": {
      return {
        kind: "generation-unknown",
        generationAttemptId: generation.attemptId,
      };
    }
    default: {
      // output_rejected, provider_failed, not_invoked, result_discarded.
      return {
        kind: "generation-failed",
        generationAttemptId: generation.attemptId,
      };
    }
  }
}

/**
 * The production per-slot executor: the first real consumer of the native
 * production generation purpose.
 *
 * It runs the actual collection → one platform-funded `google/gemini-3.8-flash`
 * request → saved result path through S5's engine, then hands an accepted
 * result to S6's real Chat and shared-outbox delivery. It never fabricates an
 * accepted result, never calls a preview HTTP route, and never issues a second
 * model request for a slot whose invocation may already have happened: S5's
 * reservation is committed before its sole POST and a replay resolves that same
 * attempt.
 */
export const executeNativeMorningBriefSlot$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefMemberIdentity;
      readonly occurrence: MorningBriefNativeOccurrenceRow;
    },
    signal: AbortSignal,
  ): Promise<NativeSlotExecution> => {
    const generation = await set(
      executeMorningBriefGeneration$,
      {
        owner: args.owner,
        scheduledFor: args.occurrence.scheduledFor,
        purpose: "production",
      },
      signal,
    );
    signal.throwIfAborted();

    const settlement = nativeSettlementOfGeneration(generation);
    if (settlement.kind !== "delivered") {
      return settlement;
    }

    // An accepted result's delivery work must be discoverable before the slot
    // is marked settled, so a failure here still leaves the obligation pending
    // rather than losing the brief.
    const delivered = await set(
      deliverMorningBriefResult$,
      {
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        resultAttemptId: settlement.generationAttemptId,
        purpose: "production",
        // The validated occurrence authority, carried into the Chat and email
        // boundary rather than checked only at settlement.
        nativeAuthority: {
          ownerEpoch: args.occurrence.ownerEpoch,
          membershipId: args.occurrence.membershipId,
        },
      },
      signal,
    );
    if (delivered.kind === "rejected") {
      log.warn("Morning Brief native delivery was rejected", {
        orgId: args.owner.orgId,
        reason: delivered.reason,
      });
    }
    return settlement;
  },
);

/**
 * Resolve one pending delivery recovery, receipt first.
 *
 * The durable receipt is looked up by the **native occurrence identity**, not
 * by the S5 result: a Chat receipt that committed before a crash stays
 * delivered after the result expires, and its shared-outbox email recovery is
 * preserved by S6 and S2. Only when no committed receipt exists is the same
 * saved result retried under current authority; nothing here regenerates and
 * nothing here settles the schedule a second time.
 */
export const recoverNativeMorningBriefDelivery$ = command(
  async (
    { set },
    args: {
      readonly owner: MorningBriefMemberIdentity;
      readonly occurrence: MorningBriefNativeOccurrenceRow;
    },
    signal: AbortSignal,
  ): Promise<"delivered" | "pending" | "terminal-failure"> => {
    const db = set(writeDb$);
    const [receipt] = await db
      .select({ chatEventId: morningBriefDeliveries.chatEventId })
      .from(morningBriefDeliveries)
      .where(
        and(
          eq(morningBriefDeliveries.orgId, args.owner.orgId),
          eq(morningBriefDeliveries.userId, args.owner.userId),
          eq(morningBriefDeliveries.scheduledFor, args.occurrence.scheduledFor),
          eq(morningBriefDeliveries.executionPurpose, "production"),
        ),
      )
      .limit(1);
    if (receipt !== undefined) {
      // Already delivered. Email recovery stays with S6's receipt and the S2
      // shared outbox; this consumer only releases the scheduler's obligation.
      return "delivered";
    }

    if (args.occurrence.generationAttemptId === null) {
      return "terminal-failure";
    }
    const retried = await set(
      deliverMorningBriefResult$,
      {
        orgId: args.owner.orgId,
        userId: args.owner.userId,
        resultAttemptId: args.occurrence.generationAttemptId,
        purpose: "production",
        nativeAuthority: {
          ownerEpoch: args.occurrence.ownerEpoch,
          membershipId: args.occurrence.membershipId,
        },
      },
      signal,
    );
    if (retried.kind === "rejected") {
      // `result-not-found` after retention has been exhausted with no committed
      // receipt is the only terminal delivery failure.
      return retried.reason === "result-not-found"
        ? "terminal-failure"
        : "pending";
    }
    return "delivered";
  },
);

/** Bind the tick to the real services. */
export function productionNativeTickDependencies(args: {
  readonly db: ReadonlyDb;
  readonly executor: NativeSlotExecutor;
  readonly delivery: NativeDeliveryRecovery;
}): NativeTickDependencies {
  const { db } = args;
  return {
    executor: args.executor,
    delivery: args.delivery,
    legacyDrain: async (owner) => {
      const schedule = await readMorningBriefNativeSchedule(db, owner);
      return await proveLegacyMorningBriefDrain(db, owner, schedule);
    },
    nativeDrain: async (owner) => {
      return await proveNativeMorningBriefDrain(db, owner);
    },
  };
}
