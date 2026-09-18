import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { emailOutbox } from "@okouai/db/schema/email-outbox";
import { morningBriefDeliveries } from "@okouai/db/schema/morning-brief-delivery";
import { morningBriefNativeOccurrences } from "@okouai/db/schema/morning-brief-native-schedule";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { logger } from "../../lib/log";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { chatEventTypeIn } from "./chat-event-type.service";
import { deliverMorningBriefResult$ } from "./morning-brief-delivery.service";
import type { MorningBriefMemberIdentity } from "./morning-brief-enrollment-data.service";
import type { MorningBriefGenerationView } from "@okouai/api-contracts/contracts/morning-brief-generation-preview";

import {
  executeMorningBriefComposedGeneration$,
  type MorningBriefComposedExecution,
} from "./morning-brief-composed-generation.service";
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

/** A Run in any of these states can still deliver a legacy result callback. */
const ACTIVE_LEGACY_RUN_STATUSES = ["queued", "pending", "running"] as const;

/** An outbox row in any of these states still owes a provider request. */
const UNSENT_OUTBOX_STATUSES = ["pending", "sending", "failed"] as const;

/** A callback in either state can still enter the legacy result writer. */
const REACHABLE_CALLBACK_STATUSES = ["pending", "failed"] as const;

const legacyEventRevoker = alias(chatEvents, "legacy_event_revoker");

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

type MorningBriefDrainVerdict =
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
 *   claim whose bound Run is **still active** has a result callback that can
 *   still write. Both keep the drain unresolved. Run liveness is read from the
 *   Run itself, not inferred from the claim's own settlement.
 * - An **unsent legacy email intent** produced by this automation is reachable
 *   mail work. The shared outbox owns its own retries, so a row that is not yet
 *   `sent` keeps the drain unresolved regardless of what the journal says.
 * - A member with **no journal rows at all** has unknown historical anchor:
 *   the journal only starts recording at S7a's deployment. The drain therefore
 *   checks the actual automation queue events, Runs, callback rows and mail
 *   intents. It holds while any is reachable and transfers only after those
 *   producers are terminal; it never reconstructs identity from `firedAt`, a
 *   Run context, title or TTL.
 *
 * It deliberately does not accept `automation.enabled = false`, an empty
 * outbox, a completed agent status by itself or one expired TTL as proof.
 */
async function proveLegacyMorningBriefDrain(
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
      total: count(),
      unsettled: count(
        sql`CASE WHEN ${eq(morningBriefScheduleClaims.settlement, "unsettled")} THEN 1 END`,
      ),
      queued: count(
        sql`CASE WHEN ${and(eq(morningBriefScheduleClaims.queueDisposition, "queued"), isNotNull(morningBriefScheduleClaims.queueEventId))} THEN 1 END`,
      ),
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

  // Reachable work the journal cannot describe on its own is read through the
  // canonical automation event relationship, not guessed from a title or Run
  // timestamp. This includes mixed-version queue events with no S7a claim.
  const [pendingEvent] = await db
    .select({ id: chatEvents.id })
    .from(chatAutomationContext)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatEvents.contextId, chatAutomationContext.id),
      ),
    )
    .where(
      and(
        eq(chatAutomationContext.automationId, schedule.legacyAutomationId),
        chatEventTypeIn(["input.automation"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: legacyEventRevoker.id })
            .from(legacyEventRevoker)
            .where(eq(legacyEventRevoker.revokesEventId, chatEvents.id)),
        ),
      ),
    )
    .limit(1);
  if (pendingEvent !== undefined) {
    return { kind: "unresolved", reason: "legacy-queue-event-pending" };
  }

  const automationEvents = db
    .select({ runId: chatEvents.runId })
    .from(chatAutomationContext)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatEvents.contextId, chatAutomationContext.id),
      ),
    )
    .where(
      and(
        eq(chatAutomationContext.automationId, schedule.legacyAutomationId),
        chatEventTypeIn(["input.automation"]),
        isNotNull(chatEvents.runId),
      ),
    )
    .as("legacy_automation_events");

  const [liveRun] = await db
    .select({ id: agentRuns.id })
    .from(automationEvents)
    .innerJoin(agentRuns, eq(agentRuns.id, automationEvents.runId))
    .where(inArray(agentRuns.status, ACTIVE_LEGACY_RUN_STATUSES))
    .limit(1);
  if (liveRun !== undefined) {
    return { kind: "unresolved", reason: "legacy-run-callback-reachable" };
  }

  const [pendingCallback] = await db
    .select({ id: agentRunCallbacks.id })
    .from(automationEvents)
    .innerJoin(
      agentRunCallbacks,
      eq(agentRunCallbacks.runId, automationEvents.runId),
    )
    .where(inArray(agentRunCallbacks.status, REACHABLE_CALLBACK_STATUSES))
    .limit(1);
  if (pendingCallback !== undefined) {
    return { kind: "unresolved", reason: "legacy-result-callback-pending" };
  }

  const [unsentMail] = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.sourceWorkflowAutomationId, schedule.legacyAutomationId),
        inArray(emailOutbox.status, UNSENT_OUTBOX_STATUSES),
      ),
    )
    .limit(1);
  if (unsentMail !== undefined) {
    return { kind: "unresolved", reason: "legacy-outbox-unsent" };
  }

  if (counts === undefined || counts.total === 0) {
    // The exact historical anchor remains unknowable, but all rows that can
    // still produce, callback or send have now been checked directly and are
    // terminal. That concrete fence — never age, title, firedAt or a missing
    // body — permits a future-only transfer while this documented identity
    // limit remains part of the protocol.
    return { kind: "proven" };
  }
  if (counts.unsettled > 0) {
    return { kind: "unresolved", reason: "legacy-claim-unsettled" };
  }
  if (counts.queued > 0) {
    return { kind: "unresolved", reason: "legacy-launch-unconsumed" };
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
async function proveNativeMorningBriefDrain(
  db: ReadonlyDb,
  owner: MorningBriefMemberIdentity,
): Promise<MorningBriefDrainVerdict> {
  const [counts] = await db
    .select({
      unsettled: count(
        sql`CASE WHEN ${isNull(morningBriefNativeOccurrences.settledAt)} THEN 1 END`,
      ),
      pendingDelivery: count(
        sql`CASE WHEN ${eq(morningBriefNativeOccurrences.deliveryPending, true)} THEN 1 END`,
      ),
    })
    .from(morningBriefNativeOccurrences)
    .where(
      and(
        eq(morningBriefNativeOccurrences.orgId, owner.orgId),
        eq(morningBriefNativeOccurrences.userId, owner.userId),
      ),
    );

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
function nativeSettlementOfGeneration(
  execution: MorningBriefComposedExecution,
): NativeSlotExecution {
  switch (execution.kind) {
    case "not-executed":
    case "denied":
    case "authority-changed": {
      // Nothing was reserved and nothing was contacted, so this is the bounded
      // pre-reservation configuration or authority branch.
      return { kind: "defer", reason: "generation-not-admitted" };
    }
    case "incomplete": {
      return { kind: "collection-failed" };
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
    const leaseToken = args.occurrence.leaseToken;
    if (leaseToken === null) {
      // The claim this slot was handed is gone, so there is nothing to execute
      // under. No collection, no reservation and no request happen.
      return { kind: "defer", reason: "native-claim-lost" };
    }

    // The native authority travels **into** S5, so its reservation transaction
    // binds the reserved attempt to this slot before the sole platform request.
    // A claim that moved while collection ran fails inside that transaction and
    // rolls the reservation back with it.
    const generation = await set(
      executeMorningBriefComposedGeneration$,
      {
        owner: args.owner,
        scheduledFor: args.occurrence.scheduledFor,
        purpose: "production",
        nativeAuthority: {
          ownerEpoch: args.occurrence.ownerEpoch,
          membershipId: args.occurrence.membershipId,
          leaseToken,
        },
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
    signal.throwIfAborted();
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
  readonly scope?: MorningBriefMemberIdentity;
}): NativeTickDependencies {
  const { db } = args;
  return {
    scope: args.scope,
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
