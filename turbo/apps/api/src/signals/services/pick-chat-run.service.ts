import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { computed, command, state } from "ccstate";
import {
  count,
  eq,
  or,
  and,
  isNull,
  lte,
  gt,
  notInArray,
  notExists,
  isNotNull,
  asc,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgConcurrencySubscriptions } from "@okouai/db/schema/org-concurrency-subscription";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { now, nowDate } from "../../lib/time";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { settle, tapError } from "../utils";
import {
  activeConcurrencySubscriptionPredicate,
  totalConcurrencyLimit,
  cappedBaseConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
} from "./api-dispatch-timing.service";
import {
  createClaimRunObjects,
  type ClaimRunTiming,
  type ThreadClaim,
  type RunContext,
} from "./claim-run-context";
import {
  type AtomicLaunchCommitCompletion,
  type CommitPreparedLaunchArgs,
  type PreparedCommitPreparedLaunchArgs,
  timingDimensionsForCreateArgs,
  commitPreparedPendingLaunch$,
  admissionAttemptOutcome,
  committedAtomicLaunchResponse,
  flushQueueFirstClaimLostTiming,
} from "./agent-run-execution.service";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import {
  morningBriefScheduleClaimBound$,
  morningBriefScheduleClaimSupersededCondition,
} from "./morning-brief-schedule-claim.service";
import { chatThreadEventInsertSql } from "./chat-thread-event.service";
import { finalizeClaimedRunUserMessage } from "./chat-run-event.service";
import { activatePendingRun$ as activateCommittedRun$ } from "./agent-run-activation.service";
import {
  recordQueuedPromptRunLaunch$,
  ChatCallbackPreCreateTimingCollector,
  queuedMessageRejection,
  rejectedQueuedRunAdmissionFailure,
  deliverQueuedPromptRejection$,
  deliverUnexpectedQueuedPromptRejection$,
} from "./internal-chat-run-callback.service";
import {
  chatEventReplacementInsertSql,
  chatEventInsertSql,
} from "./chat-event.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { settleRejectedAutomationInput$ } from "./workflow-schedule-failure.service";
import type { ChatQueueHeadRejection } from "./chat-queue-run-assembly";
import type { PendingRunActivation } from "./agent-run-activation.types";

interface OrgPickCursor {
  readonly queuedAt: Date;
  readonly chatThreadId: string;
  readonly visitedThreadIds: readonly string[];
}

/**
 * The captured lease plus the `queuedAt` observed when it was taken. Only the
 * plain `{ orgId, chatThreadId, claimId }` identity crosses into the child.
 */
interface LeasedThreadClaim extends ThreadClaim {
  readonly queuedAt: Date;
}

type PendingClaimRun = {
  readonly kind: "pending";
  readonly runId: string;
  readonly activation: PendingRunActivation;
  readonly context: RunContext;
};

type ClaimRunCommit =
  | PendingClaimRun
  | { readonly kind: "passed" }
  | {
      readonly kind: "rejected";
      readonly error: { readonly code: string; readonly message: string };
    };

const log = logger("ChatQueueConsume");

/** A picked input whose preparation or commit failed unexpectedly. */
const ABANDONED_HEAD_ERROR = {
  code: "INTERNAL_ERROR",
  message: "The input could not be started",
} as const;

/** Fixed chat thread lease; it is never renewed. See design §5.1. */
const CHAT_THREAD_LEASE_MS = 10_000;

/**
 * Reuse this outer graph for one organization pass. Each successful claim gets
 * one isolated child graph in the same request Store. The cursor advances over
 * selected work; it never retries a failed launch within this pass.
 */
/** A picked queue head a rejection records, publishes and reports. */
interface RejectedQueueHead {
  readonly id: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  /** Null once the thread's agent is deleted; the source reply needs it. */
  readonly agentId: string | null;
  readonly contextType: string | null;
  readonly contextId: string | null;
}

/**
 * One pick's outcome: the launched run, a claim released because the
 * organization had no free concurrency slot, or nothing launched.
 */
export type PickResult =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "org-full" }
  | { readonly kind: "none" };

function createClaimRunTiming(pickStartedAt: number): ClaimRunTiming {
  return {
    run: new ApiDispatchTimingCollector(),
    phase: new ApiDispatchPhaseCollector(pickStartedAt),
    prompt: new ChatCallbackPreCreateTimingCollector(),
  };
}

export function createPickObjects(orgId: string, fixedThreadId?: string) {
  const internalReloadPick$ = state(0);
  const internalOrgCursor$ = state<OrgPickCursor | null>(null);
  const orgActiveRunCount$ = computed(async (get) => {
    get(internalReloadPick$);
    const database = get(db$);
    const [row] = await database
      .select({ count: count() })
      .from(activeAgentRuns)
      .where(eq(activeAgentRuns.orgId, orgId));
    if (!row) {
      throw new Error("Active agent run count returned no row");
    }
    return row.count;
  });

  const orgCapacity$ = computed(async (get) => {
    get(internalReloadPick$);
    const database = get(db$);
    const at = nowDate();
    const [[plan], subscriptions] = await Promise.all([
      database
        .select({
          entitlementOrgId: orgPlanEntitlements.orgId,
          metadataOrgId: orgMetadata.orgId,
          baseConcurrencyLimit: orgPlanEntitlements.baseConcurrencyLimit,
        })
        .from(orgPlanEntitlements)
        .fullJoin(orgMetadata, eq(orgMetadata.orgId, orgPlanEntitlements.orgId))
        .where(
          or(
            eq(orgPlanEntitlements.orgId, orgId),
            eq(orgMetadata.orgId, orgId),
          ),
        )
        .limit(1),
      database
        .select({ slots: orgConcurrencySubscriptions.slots })
        .from(orgConcurrencySubscriptions)
        .where(activeConcurrencySubscriptionPredicate(orgId, at)),
    ]);
    if (plan?.entitlementOrgId === null && plan.metadataOrgId !== null) {
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    const limit = totalConcurrencyLimit({
      baseLimit: cappedBaseConcurrencyLimit(plan?.baseConcurrencyLimit ?? 0),
      paidSlots: subscriptions.reduce((total, row) => {
        return total + row.slots;
      }, 0),
    });
    return Number.isFinite(limit) ? limit : 0;
  });

  const orgHasCapacity$ = computed(async (get) => {
    const [activeCount, capacity] = await Promise.all([
      get(orgActiveRunCount$),
      get(orgCapacity$),
    ]);
    return capacity === 0 || activeCount < capacity;
  });

  const nextOrgThread$ = computed(async (get) => {
    get(internalReloadPick$);
    const after = get(internalOrgCursor$);
    const database = get(db$);
    const at = nowDate();
    const [row] = await database
      .select({
        chatThreadId: queuedChatThreads.chatThreadId,
        queuedAt: queuedChatThreads.queuedAt,
      })
      .from(queuedChatThreads)
      .where(
        and(
          eq(queuedChatThreads.orgId, orgId),
          or(
            isNull(queuedChatThreads.claimExpiresAt),
            lte(queuedChatThreads.claimExpiresAt, at),
          ),
          after === null
            ? undefined
            : or(
                gt(queuedChatThreads.queuedAt, after.queuedAt),
                and(
                  eq(queuedChatThreads.queuedAt, after.queuedAt),
                  gt(queuedChatThreads.chatThreadId, after.chatThreadId),
                ),
              ),
          after === null
            ? undefined
            : notInArray(queuedChatThreads.chatThreadId, [
                ...after.visitedThreadIds,
              ]),
          notExists(
            database
              .select({ runId: activeAgentRuns.runId })
              .from(activeAgentRuns)
              .where(
                eq(
                  activeAgentRuns.chatThreadId,
                  queuedChatThreads.chatThreadId,
                ),
              ),
          ),
        ),
      )
      .orderBy(
        asc(queuedChatThreads.queuedAt),
        asc(queuedChatThreads.chatThreadId),
      )
      .limit(1);
    return row ?? null;
  });

  const claim$ = command(async ({ get, set }, signal: AbortSignal) => {
    let threadId = fixedThreadId;
    if (threadId === undefined) {
      const candidate = await get(nextOrgThread$);
      signal.throwIfAborted();
      if (!candidate) {
        return null;
      }
      set(internalOrgCursor$, (previous) => {
        return {
          ...candidate,
          visitedThreadIds: [
            ...(previous?.visitedThreadIds ?? []),
            candidate.chatThreadId,
          ],
        };
      });
      threadId = candidate.chatThreadId;
    }
    const database = set(writeDb$);
    const at = nowDate();
    const claimId = randomUUID();
    const [row] = await database
      .update(queuedChatThreads)
      .set({
        claimId,
        claimExpiresAt: new Date(at.getTime() + CHAT_THREAD_LEASE_MS),
      })
      .where(
        and(
          eq(queuedChatThreads.orgId, orgId),
          eq(queuedChatThreads.chatThreadId, threadId),
          or(
            isNull(queuedChatThreads.claimExpiresAt),
            lte(queuedChatThreads.claimExpiresAt, at),
          ),
          notExists(
            database
              .select({ runId: activeAgentRuns.runId })
              .from(activeAgentRuns)
              .where(eq(activeAgentRuns.chatThreadId, threadId)),
          ),
        ),
      )
      .returning({
        chatThreadId: queuedChatThreads.chatThreadId,
        queuedAt: queuedChatThreads.queuedAt,
      });
    signal.throwIfAborted();
    const claim = row
      ? {
          orgId,
          chatThreadId: row.chatThreadId,
          claimId,
          queuedAt: row.queuedAt,
          pickStartedAt: at.getTime(),
        }
      : null;
    return claim;
  });

  /**
   * Release this claim's lease. Returns whether the lease was still ours; a
   * lease lost to expiry and another picker releases nothing.
   */
  const releaseClaim$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const [row] = await set(writeDb$)
        .update(queuedChatThreads)
        .set({ claimId: null, claimExpiresAt: null })
        .where(
          and(
            eq(queuedChatThreads.orgId, claim.orgId),
            eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
            eq(queuedChatThreads.claimId, claim.claimId),
          ),
        )
        .returning({ chatThreadId: queuedChatThreads.chatThreadId });
      signal.throwIfAborted();
      return row !== undefined;
    },
  );

  /**
   * New input may remain behind this claim, so discover it with one fresh
   * fixed-thread pick in the background, as the enqueue scheduler does after
   * a commit. The scheduler lives in chat-thread-queue-drain, which imports
   * this module, so the pick is built here on the same request Store. This is
   * new work, not a retry: `pick$` never loops.
   */
  const scheduleThreadPick$ = command(
    async (
      { get, set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<void> => {
      const { pick$: nextPick$ } = await get(
        computed(() => {
          return createPickObjects(claim.orgId, claim.chatThreadId);
        }),
      );
      signal.throwIfAborted();
      waitUntil(set(nextPick$, signal));
    },
  );

  /** Release a claim that left input in the queue and pick the thread again. */
  const releaseClaimAndSchedulePick$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<void> => {
      if (await set(releaseClaim$, claim, signal)) {
        await set(scheduleThreadPick$, claim, signal);
      }
    },
  );

  /**
   * Delete the empty queue row only while both the token and `queuedAt` are
   * unchanged. A miss while the lease is still ours means input arrived under
   * this lease; its enqueuer's pick could not claim, so release and pick again.
   */
  const deleteEmptyQueue$ = command(
    async (
      { set },
      claim: LeasedThreadClaim,
      signal: AbortSignal,
    ): Promise<void> => {
      const [deleted] = await set(writeDb$)
        .delete(queuedChatThreads)
        .where(
          and(
            eq(queuedChatThreads.orgId, claim.orgId),
            eq(queuedChatThreads.chatThreadId, claim.chatThreadId),
            eq(queuedChatThreads.claimId, claim.claimId),
            eq(queuedChatThreads.queuedAt, claim.queuedAt),
          ),
        )
        .returning({ chatThreadId: queuedChatThreads.chatThreadId });
      signal.throwIfAborted();
      if (!deleted) {
        await set(releaseClaimAndSchedulePick$, claim, signal);
      }
    },
  );

  const publishChatQueueHeadConsumed$ = command(
    async (
      _context,
      head: {
        readonly chatThreadId: string;
        readonly orgId: string;
        readonly userId: string;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      await publishChatThreadMessageCreatedSafely({
        userId: head.userId,
        orgId: head.orgId,
        threadId: head.chatThreadId,
      });
      signal.throwIfAborted();
      await publishThreadListChangedSafely({
        userId: head.userId,
        orgId: head.orgId,
      });
      signal.throwIfAborted();
    },
  );
  const directSendInsufficientCreditsMessage$ = computed(async (get) => {
    get(internalReloadPick$);
    const db = get(db$);
    const [capabilities] = await db
      .select({
        canBuyCredits: orgPlanEntitlements.canBuyCredits,
        restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
      })
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    if (!capabilities) {
      const [org] = await db
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      if (org) {
        throw new Error(`Missing org plan entitlement for ${orgId}`);
      }
    } else if (capabilities.restrictedBuiltInModels === null) {
      throw new Error(
        `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
      );
    }
    const appUrl = env("APP_URL");
    return [
      "Insufficient credits. This workspace has no spendable credits right now.",
      "",
      capabilities?.canBuyCredits === true
        ? `Buy more credits or adjust auto-recharge: ${appUrl}/?settings=usage`
        : `Upgrade to Pro to get more credits: ${appUrl}/?settings=billing&billingView=plans`,
    ].join("\n");
  });

  /**
   * The one rejection of a picked queue head, for business rejections and
   * unexpected preparation or commit failures alike: record the rejected input
   * and its error message, settle an automation tick, publish the realtime
   * event and deliver the failure to the source integration. With `lease`, the
   * rejection and the release of that lease commit together, and only while
   * the claim still holds it; otherwise the transaction rolls back and nothing
   * changes. The queue row is locked last, as enqueue does.
   */
  const rejectionInput$ = command(
    async ({ get }, head: RejectedQueueHead, signal: AbortSignal) => {
      const [source] = await get(db$)
        .select({
          id: chatEvents.id,
          chatThreadId: chatEvents.chatThreadId,
          eventType: chatEvents.eventType,
          userMessage: canonicalChatEventUserMessage(),
          createdAt: chatEvents.createdAt,
          contextType: chatEvents.contextType,
          contextId: chatEvents.contextId,
          modelSelection: canonicalChatInputModelSelection(),
        })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.id, head.id),
            eq(chatEvents.chatThreadId, head.chatThreadId),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!source?.userMessage) {
        throw new Error("Queued input event is missing userMessage");
      }
      return { ...source, userMessage: source.userMessage };
    },
  );
  const commitQueueHeadRejection$ = command(
    async (
      { set },
      args: {
        readonly head: RejectedQueueHead;
        readonly errorMarker: string;
        readonly displayError: string;
        readonly lease?: LeasedThreadClaim;
      },
      signal: AbortSignal,
    ) => {
      const source = await set(rejectionInput$, args.head, signal);
      const rejectedAt = new Date(
        Math.max(nowDate().getTime(), source.createdAt.getTime() + 1),
      );
      return await set(writeDb$).transaction(async (tx) => {
        const rejected =
          parseRawRows(
            chatEventCommandResultSchema,
            await tx.execute(
              chatEventReplacementInsertSql(source, {
                chatThreadId: source.chatThreadId,
                eventType: "input.rejected",
                userMessage: source.userMessage,
                runId: null,
                error: args.errorMarker,
                createdAt: rejectedAt,
              }),
            ),
          )[0] ?? null;
        signal.throwIfAborted();
        let appended: {
          readonly assistantEventId: string;
          readonly contextType: string | null;
          readonly contextId: string | null;
        } | null = null;
        if (rejected) {
          const assistant =
            parseRawRows(
              chatEventCommandResultSchema,
              await tx.execute(
                chatEventInsertSql({
                  chatThreadId: source.chatThreadId,
                  eventType: "output.error",
                  content: args.displayError,
                  runId: null,
                  error: args.errorMarker,
                  createdAt: new Date(rejectedAt.getTime() + 1),
                }),
              ),
            )[0] ?? null;
          signal.throwIfAborted();
          if (!assistant) {
            throw new Error("Failed to append queued input rejection");
          }
          const [thread] = await tx
            .update(chatThreads)
            .set({
              lastMessageAt: sql`GREATEST(${chatThreads.lastMessageAt}, ${assistant.createdAt.toISOString()}::timestamp)`,
            })
            .where(
              and(
                eq(chatThreads.id, source.chatThreadId),
                isNotNull(chatThreads.agentId),
              ),
            )
            .returning({
              id: chatThreads.id,
              userId: chatThreads.userId,
              agentId: chatThreads.agentId,
              lastMessageAt: chatThreads.lastMessageAt,
            });
          signal.throwIfAborted();
          if (thread?.agentId) {
            await tx.execute(
              chatThreadEventInsertSql({
                kind: "sort_touched",
                userId: thread.userId,
                chatThreadId: thread.id,
                agentId: thread.agentId,
                createdAt: thread.lastMessageAt,
              }),
            );
            signal.throwIfAborted();
          }
          appended = {
            assistantEventId: assistant.id,
            contextType: source.contextType,
            contextId: source.contextId,
          };
        }
        if (args.lease) {
          const { lease } = args;
          const [released] = await tx
            .update(queuedChatThreads)
            .set({ claimId: null, claimExpiresAt: null })
            .where(
              and(
                eq(queuedChatThreads.orgId, lease.orgId),
                eq(queuedChatThreads.chatThreadId, lease.chatThreadId),
                eq(queuedChatThreads.claimId, lease.claimId),
              ),
            )
            .returning({ chatThreadId: queuedChatThreads.chatThreadId });
          signal.throwIfAborted();
          if (!released) {
            tx.rollback();
          }
        }
        return appended;
      });
    },
  );
  const rejectChatQueueHead$ = command(
    async (
      { get, set },
      args: {
        readonly head: RejectedQueueHead;
        readonly rejection: ChatQueueHeadRejection;
        readonly lease?: LeasedThreadClaim;
      },
      signal: AbortSignal,
    ): Promise<void> => {
      const { head, rejection, lease } = args;
      const { error } = rejection;
      const displayError =
        error.code === "CONFLICT"
          ? error.message
          : error.code === "INSUFFICIENT_CREDITS" &&
              (head.contextType === "web" || head.contextType === "agent_run")
            ? await get(directSendInsufficientCreditsMessage$)
            : await set(
                formatIntegrationRunError$,
                {
                  orgId: head.orgId,
                  userId: rejection.userId,
                  code: error.code,
                  message: error.message,
                },
                signal,
              );
      signal.throwIfAborted();
      const rejected = await set(
        commitQueueHeadRejection$,
        { head, errorMarker: error.code.toLowerCase(), displayError, lease },
        signal,
      );
      signal.throwIfAborted();
      if (!rejected) {
        return;
      }
      const logRejection =
        error.code === "INSUFFICIENT_CREDITS" ? log.debug : log.warn;
      logRejection("Rejected queued chat input", {
        chatThreadId: head.chatThreadId,
        eventId: head.id,
        contextType: head.contextType,
        code: error.code,
        error: error.message,
      });
      if (head.contextType === "automation") {
        await set(
          settleRejectedAutomationInput$,
          { contextId: head.contextId, queueEventId: head.id, error },
          signal,
        );
      }
      await set(publishChatQueueHeadConsumed$, head, signal);
      const agentId = head.agentId;
      const delivery = rejection.delivery
        ? set(
            deliverQueuedPromptRejection$,
            rejection.delivery,
            rejected.assistantEventId,
            signal,
          )
        : error.code === "INTERNAL_ERROR" && agentId !== null
          ? set(
              deliverUnexpectedQueuedPromptRejection$,
              {
                head: { ...head, agentId },
                assistantEventId: rejected.assistantEventId,
              },
              signal,
            )
          : undefined;
      if (delivery) {
        await tapError(delivery, (deliveryError) => {
          log.warn("Failed to deliver queued input rejection", {
            chatThreadId: head.chatThreadId,
            eventId: head.id,
            error: deliveryError,
          });
        });
      }
    },
  );

  const rejectEvent$ = command(
    async (
      { set },
      context: RunContext,
      error: { readonly code: string; readonly message: string },
      signal: AbortSignal,
    ): Promise<void> => {
      const rejection: ChatQueueHeadRejection =
        context.rejection.kind === "prompt"
          ? queuedMessageRejection(
              rejectedQueuedRunAdmissionFailure(
                context.rejection.runInput,
                error,
              ),
            )
          : { userId: context.rejection.userId, error };
      await set(
        rejectChatQueueHead$,
        { head: context.head, rejection },
        signal,
      );
    },
  );

  // Record the committed result and its activation metadata only after the
  // pending transaction returns. This command does no launch preparation.
  const recordRunCommit$ = command(
    (
      _store,
      context: RunContext,
      committed: AtomicLaunchCommitCompletion,
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ): ClaimRunCommit => {
      const { input, identity, launch } = context;
      signal.throwIfAborted();
      if ("status" in committed.result) {
        return { kind: "rejected", error: committed.result.body.error };
      }
      if (committed.result.kind === "queue-first-claim-lost") {
        flushQueueFirstClaimLostTiming({
          createArgs: input.args,
          identity,
          launch,
          timing: timing.run,
          phaseTiming: timing.phase,
        });
        return { kind: "passed" };
      }
      const result = committedAtomicLaunchResponse({
        createArgs: { ...input.args, body: input.context.body },
        committed: committed.result,
        transactionReturnedAt: committed.transactionReturnedAt,
        timing: timing.run,
        phaseTiming: timing.phase,
      });
      if (!result.pendingActivation) {
        throw new Error("Pending run is missing activation metadata");
      }
      return {
        kind: "pending",
        runId: result.body.runId,
        activation: result.pendingActivation,
        context,
      };
    },
  );

  const createRun$ = command(
    async (
      { set },
      {
        claim,
        context,
        timing,
      }: {
        readonly claim: ThreadClaim;
        readonly context: RunContext;
        readonly timing: ClaimRunTiming;
      },
      signal: AbortSignal,
    ): Promise<ClaimRunCommit> => {
      signal.throwIfAborted();
      const { input, identity, callbackRows, launch } = context;
      if (
        input.args.orgId !== claim.orgId ||
        input.args.chatThreadId !== claim.chatThreadId ||
        context.head.chatThreadId !== claim.chatThreadId
      ) {
        throw new Error("Prepared run does not belong to this thread claim");
      }
      const commit: CommitPreparedLaunchArgs = {
        allowanceRefresh: context.allowanceRefresh,
        createArgs: input.args,
        enforceBuiltInCredits: input.enforceBuiltInCredits,
        context: input.context,
        identity,
        callbackRows,
        launch,
        timing: timing.run,
      };
      const admissionTiming = new AdmissionAttemptTiming({
        runId: identity.runId,
        runnerGroup: launch.runnerJobPayload.runnerGroup,
        profile: launch.runnerJobPayload.profile,
        dimensions: timingDimensionsForCreateArgs(input.args),
        ...(input.context.body.triggerSource
          ? { triggerSource: input.context.body.triggerSource }
          : {}),
      });
      const preparedCommit: PreparedCommitPreparedLaunchArgs = {
        ...commit,
        persistence: context.persistence,
        admissionTiming,
      };
      const committed: AtomicLaunchCommitCompletion = await timing.run.measure(
        "api_dispatch_insert_run_with_concurrency",
        "top_level",
        async () => {
          const result = await set(
            commitPreparedPendingLaunch$,
            preparedCommit,
            { ...claim, producer: context.producerBinding },
            signal,
          );
          const transactionReturnedAt = now();
          await admissionTiming.finish(admissionAttemptOutcome(result));
          signal.throwIfAborted();
          return { result, transactionReturnedAt };
        },
      );
      signal.throwIfAborted();
      return set(recordRunCommit$, context, committed, timing, signal);
    },
  );

  const activatePendingRun$ = command(
    async (
      { set },
      pending: PendingClaimRun,
      timing: ClaimRunTiming,
      signal: AbortSignal,
    ) => {
      await set(
        activateCommittedRun$,
        { activation: pending.activation, activationScheduledAt: now() },
        signal,
      );
      const launched = pending.context.launchRecord;
      if (launched.kind === "prompt") {
        set(
          recordQueuedPromptRunLaunch$,
          launched.context,
          pending.runId,
          timing.prompt,
          signal,
        );
      } else {
        await finalizeClaimedRunUserMessage({
          orgId: launched.orgId,
          threadId: launched.threadId,
          userId: launched.userId,
        });
        signal.throwIfAborted();
        const database = set(writeDb$);
        const lastRunFields = () => {
          return {
            ...(launched.recordLastRunId ? { lastRunId: pending.runId } : {}),
            ...(launched.recordLastRunAt ? { lastRunAt: nowDate() } : {}),
            ...(launched.disableClaimedOnceSchedule ? { enabled: false } : {}),
            updatedAt: nowDate(),
          };
        };
        if (await set(morningBriefScheduleClaimBound$, pending.runId, signal)) {
          signal.throwIfAborted();
          // Only journaled occurrences require this post-commit lock. Read
          // supersession after acquiring it so a concurrent claim is visible.
          await database.transaction(async (tx) => {
            const [locked] = await tx
              .select({ id: workflowAutomations.id })
              .from(workflowAutomations)
              .where(eq(workflowAutomations.id, launched.automationId))
              .limit(1)
              .for("update");
            signal.throwIfAborted();
            if (!locked) {
              return;
            }
            const [observation] = await tx
              .select({
                superseded: morningBriefScheduleClaimSupersededCondition(
                  pending.runId,
                ).mapWith(pgBooleanDecoder),
              })
              .from(sql`(SELECT 1) AS schedule_claim_observation`);
            signal.throwIfAborted();
            if (!observation) {
              throw new Error("Schedule claim observation returned no row");
            }
            if (observation.superseded) {
              return;
            }
            await tx
              .update(workflowAutomations)
              .set(lastRunFields())
              .where(eq(workflowAutomations.id, launched.automationId));
          });
        } else {
          await database
            .update(workflowAutomations)
            .set(lastRunFields())
            .where(eq(workflowAutomations.id, launched.automationId));
        }
        signal.throwIfAborted();
      }
      await set(publishChatQueueHeadConsumed$, pending.context.head, signal);
    },
  );

  /**
   * Claim one thread and launch its head. The claimed head is prepared and
   * committed under `settle`: a rejected head or `passed` preparation only
   * releases this claim, and an unexpected failure there marks the head
   * rejected so it cannot stay queued. A pending commit fences and clears the
   * lease in its own transaction, so the launched path has no separate release.
   */
  const pick$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<PickResult> => {
      signal.throwIfAborted();
      set(internalReloadPick$, (revision) => {
        return revision + 1;
      });
      const claim = await set(claim$, signal);
      signal.throwIfAborted();
      if (!claim) {
        return { kind: "none" };
      }
      const claimed = await get(
        computed(() => {
          return createClaimRunObjects({
            orgId: claim.orgId,
            chatThreadId: claim.chatThreadId,
            claimId: claim.claimId,
            pickStartedAt: claim.pickStartedAt,
          });
        }),
      );
      signal.throwIfAborted();
      const [hasCapacity, event] = await Promise.all([
        get(orgHasCapacity$),
        get(claimed.pickedEvent$),
      ]);
      signal.throwIfAborted();
      if (!hasCapacity) {
        await set(releaseClaim$, claim, signal);
        return { kind: "org-full" };
      }
      if (!event) {
        await set(deleteEmptyQueue$, claim, signal);
        return { kind: "none" };
      }
      const timing = createClaimRunTiming(claim.pickStartedAt);
      const settled = await settle(
        (async (): Promise<PendingClaimRun | null> => {
          const context = await set(claimed.prepareRunContext$, timing, signal);
          signal.throwIfAborted();
          if (context.kind === "passed") {
            await set(releaseClaim$, claim, signal);
            return null;
          }
          const committed = await set(
            createRun$,
            { claim, context, timing },
            signal,
          );
          if (committed.kind === "pending") {
            return committed;
          }
          if (committed.kind === "rejected") {
            await set(rejectEvent$, context, committed.error, signal);
          }
          await set(releaseClaim$, claim, signal);
          return null;
        })(),
        signal,
      );
      if (!settled.ok) {
        // The picked head must not stay queued after an unexpected failure;
        // it is rejected like any other head. The rejection's own failure is
        // left to lease expiry, and the original error still propagates.
        await settle(
          set(
            rejectChatQueueHead$,
            {
              head: {
                id: event.id,
                chatThreadId: claim.chatThreadId,
                orgId: claim.orgId,
                userId: event.userId,
                agentId: event.agentId,
                contextType: event.contextType,
                contextId: event.contextId,
              },
              rejection: { userId: event.userId, error: ABANDONED_HEAD_ERROR },
              lease: claim,
            },
            signal,
          ),
          signal,
        );
        throw settled.error;
      }
      const pending = settled.value;
      if (!pending) {
        return { kind: "none" };
      }
      waitUntil(set(claimed.updatePresignedUrlCache$, signal));
      await set(activatePendingRun$, pending, timing, signal);
      return { kind: "launched", runId: pending.runId };
    },
  );
  return { pick$ };
}
