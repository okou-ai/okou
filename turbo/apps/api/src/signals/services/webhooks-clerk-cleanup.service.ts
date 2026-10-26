import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { agents } from "@okouai/db/schema/agent";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import { morningBriefScheduleClaims } from "@okouai/db/schema/morning-brief-schedule-claim";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import { and, count, eq, inArray } from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { publishCancelToRunnerGroup } from "../external/realtime";
import {
  getStripeClient,
  listAllStripeSubscriptions,
} from "../external/stripe-client";
import { tapError } from "../utils";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";
import {
  cancelClerkBannedUserRuns$,
  cancelClerkDeletedOwnerRuns$,
  type DeletedOwner,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { cancelEmptyUsagePackSubscription$ } from "./billing-downgrade.service";
import { appendCanonicalChatEventsSql } from "./chat-event-append.service";
import { pendingChatQueueEventCondition } from "./chat-event-queue.service";
import { cancelAndRefundOrgBillingForDeletion$ } from "./org-deletion-billing.service";
import { cleanupOrgMemberResources$ } from "./org-member-cleanup.service";
import { eraseRemoteOwnerData$ } from "./remote-owner-erasure.service";
import { removeUsagePackMemberAllocation$ } from "./usage-pack-allocation-change.service";
import { refundUsagePackMemberCredits$ } from "./usage-pack-credit-refund.service";
import { deleteWechatOwnerData$ } from "./wechat-owner-cleanup.service";
import { workflowScheduleRevocationRows } from "./workflow-automation-enqueue.service";

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
    await set(cancelAndRefundOrgBillingForDeletion$, orgId, signal);
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
    await set(refundUsagePackMemberCredits$, args, signal);
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
    const cancelled = await set(cancelClerkBannedUserRuns$, userId, signal);
    set(
      scheduleReleasedSlotPicks$,
      cancelled.flatMap((run) => {
        return run.releasedOrgId === null
          ? []
          : [{ runId: run.runId, orgId: run.releasedOrgId }];
      }),
      signal,
    );
    await Promise.all(
      cancelled.map((run) => {
        return publishCancelBestEffort(run.runnerGroup, run.runId);
      }),
    );
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
