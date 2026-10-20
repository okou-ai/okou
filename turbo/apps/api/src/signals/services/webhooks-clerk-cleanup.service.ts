import { deleteWechatOwnerData$ } from "./wechat-owner-cleanup.service";
import { eraseRemoteOwnerData$ } from "./remote-owner-erasure.service";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { piMemoryStage1Days } from "@okouai/db/schema/pi-memory-stage1-schedule";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { tapError } from "../utils";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";
import {
  cancelClerkDeletedOwnerRuns$,
  releaseNeverStartedRunSlots,
  transitionAgentRunsToTerminal,
  type DeletedOwner,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { cancelEmptyUsagePackSubscription$ } from "./billing-downgrade.service";
import { appendCanonicalChatEventsSql } from "./chat-event-append.service";
import { pendingChatQueueEventCondition } from "./chat-event-queue.service";
import { workflowScheduleRevocationRows } from "./workflow-automation-enqueue.service";
import { cancelAndRefundOrgBillingForDeletion } from "./org-deletion-billing.service";
import { cleanupOrgMemberResources$ } from "./org-member-cleanup.service";
import { removeUsagePackMemberAllocation$ } from "./usage-pack-allocation-change.service";
import { refundUsagePackMemberCredits } from "./usage-pack-credit-refund.service";

const L = logger("WebhookClerkCleanup");
type SlotsReleased = (slots: readonly ReleasedRunSlot[]) => void;

async function publishCancelBestEffort(
  runnerGroup: string | null,
  runId: string,
): Promise<void> {
  if (!runnerGroup) {
    return;
  }
  await tapError(
    publishCancelToRunnerGroup(runnerGroup, runId, "hard"),
    (error) => {
      L.warn("failed to publish run cancellation", {
        runId,
        runnerGroup,
        error,
      });
    },
  );
}

// Ban behavior is deliberately separate from account-deletion stop behavior.
async function cancelUserRuns(
  db: Db,
  userId: string,
  onSlotsReleased: SlotsReleased,
): Promise<void> {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0320; new non-billing transactions are prohibited.
  const { cancelled, releasedSlots } = await db.transaction(async (tx) => {
    const rows = await transitionAgentRunsToTerminal(tx, {
      values: {
        status: "cancelled",
        completedAt: nowDate(),
        runnerCancellationMode: "hard",
      },
      conditions: [
        eq(agentRuns.userId, userId),
        inArray(agentRuns.status, ["pending", "running"]),
      ],
    });
    const released = await releaseNeverStartedRunSlots(tx, rows);
    return { cancelled: rows, releasedSlots: released };
  });
  onSlotsReleased(releasedSlots);
  await Promise.all(
    cancelled.map((run) => {
      return publishCancelBestEffort(run.runnerGroup, run.runId);
    }),
  );
}

/** Stop future dispatch without removing the owner's stored content or intent. */
const stopClerkDeletedOwnerSchedules$ = command(
  async ({ set }, owner: DeletedOwner, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const stoppedAt = nowDate();
    await db
      .update(workflowAutomations)
      .set({ enabled: false, updatedAt: stoppedAt })
      .where(
        owner.kind === "user"
          ? eq(workflowAutomations.ownerUserId, owner.userId)
          : eq(workflowAutomations.orgId, owner.orgId),
      );
    signal.throwIfAborted();
    await db
      .update(morningBriefEnrollments)
      .set({ state: "departed", updatedAt: stoppedAt })
      .where(
        and(
          owner.kind === "user"
            ? eq(morningBriefEnrollments.userId, owner.userId)
            : eq(morningBriefEnrollments.orgId, owner.orgId),
          inArray(morningBriefEnrollments.state, ["checking", "pending"]),
        ),
      );
    signal.throwIfAborted();
    // Keep journal identity and history; only unsettled occurrences stop.
    await db
      .update(morningBriefScheduleClaims)
      .set({
        settlement: "revoked",
        settledAt: stoppedAt,
        updatedAt: stoppedAt,
      })
      .where(
        and(
          owner.kind === "user"
            ? eq(morningBriefScheduleClaims.ownerUserId, owner.userId)
            : eq(morningBriefScheduleClaims.orgId, owner.orgId),
          eq(morningBriefScheduleClaims.settlement, "unsettled"),
        ),
      );
    signal.throwIfAborted();
    await db
      .update(piMemoryStage1Days)
      .set({ consumedAt: stoppedAt })
      .where(
        and(
          owner.kind === "user"
            ? eq(piMemoryStage1Days.userId, owner.userId)
            : eq(piMemoryStage1Days.orgId, owner.orgId),
          isNull(piMemoryStage1Days.consumedAt),
        ),
      );
    signal.throwIfAborted();
    // Only unfinished control rows change. Generated memories, summaries,
    // source hashes, blob references, watermarks and successful rows survive.
    await db
      .update(piMemoryStage1Candidates)
      .set({
        status: "terminal_failure",
        leaseToken: null,
        leaseExpiresAt: null,
        retryAt: null,
        lastErrorClass: "owner_deleted",
        updatedAt: stoppedAt,
      })
      .where(
        and(
          owner.kind === "user"
            ? eq(piMemoryStage1Candidates.userId, owner.userId)
            : eq(piMemoryStage1Candidates.orgId, owner.orgId),
          inArray(piMemoryStage1Candidates.status, [
            "pending",
            "retryable_failure",
            "leased",
          ]),
        ),
      );
    signal.throwIfAborted();
    await db
      .update(piMemoryPhase2Jobs)
      .set({
        status: "terminal_failure",
        claimedRevision: null,
        claimedBaseVersionId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        retryCount: 3,
        retryAt: null,
        lastErrorClass: "owner_deleted",
        claimedSelectionDigest: null,
        claimedSelectedCount: null,
        claimedSelectedUtf8Bytes: null,
        maintenanceRunId: null,
        updatedAt: stoppedAt,
      })
      .where(
        and(
          owner.kind === "user"
            ? eq(piMemoryPhase2Jobs.userId, owner.userId)
            : eq(piMemoryPhase2Jobs.orgId, owner.orgId),
          or(
            inArray(piMemoryPhase2Jobs.status, [
              "pending",
              "retryable_failure",
              "leased",
            ]),
            and(
              eq(piMemoryPhase2Jobs.status, "terminal_failure"),
              eq(piMemoryPhase2Jobs.lastErrorClass, "mixed_source_credentials"),
            ),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);

/** Revoke queued inputs and remove dispatch markers before the lifecycle owner
 * atomically hard-cancels owned work and releases its slots. Already in-flight
 * requests may finish; this is not a writer fence or reconciliation loop.
 */
const stopClerkDeletedOwnerRuns$ = command(
  async ({ set }, owner: DeletedOwner, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    // The input events are the queue; dispatch markers alone can be repaired
    // by cron or completion. Append revocations and retain the original events.
    const pendingInputs = await db
      .select({
        id: chatEvents.id,
        chatThreadId: chatEvents.chatThreadId,
        createdAt: chatEvents.createdAt,
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(
        and(
          owner.kind === "user"
            ? eq(chatThreads.userId, owner.userId)
            : inArray(
                chatThreads.agentId,
                db
                  .select({ id: agents.id })
                  .from(agents)
                  .where(eq(agents.orgId, owner.orgId)),
              ),
          pendingChatQueueEventCondition(),
        ),
      );
    signal.throwIfAborted();
    if (pendingInputs.length > 0) {
      await db.execute(
        appendCanonicalChatEventsSql(
          pendingInputs.flatMap((event) => {
            return workflowScheduleRevocationRows({
              chatThreadId: event.chatThreadId,
              targets: [event],
              currentTime: nowDate(),
            });
          }),
          "any",
        ),
      );
      signal.throwIfAborted();
    }
    await db
      .delete(queuedChatThreads)
      .where(
        owner.kind === "organization"
          ? eq(queuedChatThreads.orgId, owner.orgId)
          : inArray(
              queuedChatThreads.chatThreadId,
              db
                .select({ id: chatThreads.id })
                .from(chatThreads)
                .where(eq(chatThreads.userId, owner.userId)),
            ),
      );
    signal.throwIfAborted();
    const runs = await set(cancelClerkDeletedOwnerRuns$, owner, signal);
    signal.throwIfAborted();
    await Promise.all(
      runs.map((run) => {
        return publishCancelBestEffort(run.runnerGroup, run.runId);
      }),
    );
    signal.throwIfAborted();
  },
);

interface StripeSubscriptionCleanupTargets {
  readonly cancelNowSubscriptionIds: Set<string>;
  readonly cancelAtPeriodEndSubscriptionIds: Set<string>;
  readonly nonRenewingSubscriptionIds: Set<string>;
}

function queueStripeSubscriptionCleanup(
  targets: StripeSubscriptionCleanupTargets,
  subscription: {
    readonly id: string;
    readonly status: string | null;
    readonly cancel_at_period_end: boolean | null;
  },
): void {
  if (subscription.status === "canceled") {
    targets.nonRenewingSubscriptionIds.add(subscription.id);
    return;
  }
  if (subscription.status === "trialing") {
    targets.cancelNowSubscriptionIds.add(subscription.id);
    return;
  }
  if (subscription.cancel_at_period_end) {
    targets.nonRenewingSubscriptionIds.add(subscription.id);
    return;
  }
  targets.cancelAtPeriodEndSubscriptionIds.add(subscription.id);
}

function queueFallbackStripeSubscriptionCleanup(
  targets: StripeSubscriptionCleanupTargets,
  subscriptionId: string | null,
  subscriptionStatus: string | null,
): void {
  if (
    !subscriptionId ||
    subscriptionStatus === "canceled" ||
    targets.nonRenewingSubscriptionIds.has(subscriptionId) ||
    targets.cancelNowSubscriptionIds.has(subscriptionId) ||
    targets.cancelAtPeriodEndSubscriptionIds.has(subscriptionId)
  ) {
    return;
  }
  if (subscriptionStatus === "trialing") {
    targets.cancelNowSubscriptionIds.add(subscriptionId);
    return;
  }
  targets.cancelAtPeriodEndSubscriptionIds.add(subscriptionId);
}

export const cleanupClerkDeletedOrg$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const owner = { kind: "organization", orgId } as const;
    await set(deleteWechatOwnerData$, owner, signal);
    await set(stopClerkDeletedOwnerSchedules$, owner, signal);
    await set(stopClerkDeletedOwnerRuns$, owner, signal);
    signal.throwIfAborted();
    await set(eraseRemoteOwnerData$, owner, signal);
  },
);

export const cleanupClerkDeletedOrgBilling$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await cancelAndRefundOrgBillingForDeletion(db, orgId, signal);
    signal.throwIfAborted();
  },
);

export const cleanupClerkDeletedUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const owner = { kind: "user", userId } as const;
    await set(deleteWechatOwnerData$, owner, signal);
    await set(stopClerkDeletedOwnerSchedules$, owner, signal);
    await set(stopClerkDeletedOwnerRuns$, owner, signal);
    signal.throwIfAborted();
    await set(eraseRemoteOwnerData$, owner, signal);
  },
);

const commitClerkDeletedOrgMembershipCleanup$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId?: string;
    },
    onSlotsReleased: SlotsReleased,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const emptyCancellation = await set(
      removeUsagePackMemberAllocation$,
      args,
      signal,
    );
    signal.throwIfAborted();
    if (emptyCancellation) {
      await set(cancelEmptyUsagePackSubscription$, emptyCancellation, signal);
      signal.throwIfAborted();
    }
    await refundUsagePackMemberCredits(db, args, signal);
    signal.throwIfAborted();
    await set(cleanupOrgMemberResources$, args, onSlotsReleased, signal);
    signal.throwIfAborted();
  },
);

export const cleanupClerkDeletedOrgMembership$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId?: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      commitClerkDeletedOrgMembershipCleanup$,
      args,
      (slots) => {
        set(scheduleReleasedSlotPicks$, slots, signal);
      },
      new AbortController().signal,
    );
    signal.throwIfAborted();
  },
);

export const cleanupClerkBannedUser$ = command(
  async ({ set }, userId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await cancelUserRuns(db, userId, (slots) => {
      set(scheduleReleasedSlotPicks$, slots, signal);
    });
    signal.throwIfAborted();
    await (async (): Promise<void> => {
      const adminOrgs = await db
        .select({ orgId: orgMembersCache.orgId })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.userId, userId),
            eq(orgMembersCache.role, "admin"),
          ),
        );
      for (const { orgId } of adminOrgs) {
        const [result] = await db
          .select({ adminCount: count() })
          .from(orgMembersCache)
          .where(
            and(
              eq(orgMembersCache.orgId, orgId),
              eq(orgMembersCache.role, "admin"),
            ),
          );
        if ((result?.adminCount ?? 0) <= 1) {
          await tapError(
            (async (): Promise<void> => {
              const [meta] = await db
                .select({
                  stripeCustomerId: orgMetadata.stripeCustomerId,
                  stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
                  subscriptionStatus: orgMetadata.subscriptionStatus,
                })
                .from(orgMetadata)
                .where(eq(orgMetadata.orgId, orgId))
                .limit(1);
              if (!meta?.stripeCustomerId && !meta?.stripeSubscriptionId) {
                return;
              }
              const stripe = getStripeClient();
              const targets: StripeSubscriptionCleanupTargets = {
                cancelNowSubscriptionIds: new Set<string>(),
                cancelAtPeriodEndSubscriptionIds: new Set<string>(),
                nonRenewingSubscriptionIds: new Set<string>(),
              };
              if (meta.stripeCustomerId) {
                const subscriptions = await listAllStripeSubscriptions(stripe, {
                  customer: meta.stripeCustomerId,
                  status: "all",
                });
                for (const subscription of subscriptions) {
                  queueStripeSubscriptionCleanup(targets, subscription);
                }
              }
              queueFallbackStripeSubscriptionCleanup(
                targets,
                meta.stripeSubscriptionId,
                meta.subscriptionStatus,
              );
              for (const subscriptionId of targets.cancelNowSubscriptionIds) {
                await stripe.subscriptions.cancel(subscriptionId);
              }
              for (const subscriptionId of targets.cancelAtPeriodEndSubscriptionIds) {
                await stripe.subscriptions.update(subscriptionId, {
                  cancel_at_period_end: true,
                });
              }
            })(),
            (error) => {
              L.warn(
                "failed to cancel stripe subscriptions for banned last admin",
                { userId, orgId, error },
              );
            },
          );
        }
      }
    })();
  },
);
