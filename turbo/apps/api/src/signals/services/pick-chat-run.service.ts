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
  asc,
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
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { db$, writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import type { Tx } from "../../lib/db-types";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { isFreePlanForCreditAdmission } from "./run-admission.service";
import { now, nowDate } from "../../lib/time";
import { conflict } from "../../lib/error";
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
  type AtomicLaunchCommitResult,
  type CommitPreparedLaunchArgs,
  type PreparedCommitPreparedLaunchArgs,
  timingDimensionsForCreateArgs,
  admissionAttemptOutcome,
  validateThreadSessionSnapshot,
  validateCapturedSubscriptionAccount,
  buildAtomicLaunchCteContext,
  persistPendingAtomicLaunch,
  persistThreadSessionBinding,
  committedAtomicLaunchResponse,
  flushQueueFirstClaimLostTiming,
} from "./agent-run-execution.service";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import {
  acquireOfficialWorkflowRunCatalogAdmissionLock,
  validateOfficialWorkflowRunForInsert,
} from "./official-workflow-run.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  resolveQueueFirstRunAdmission,
  claimQueueFirstRunAssociation,
} from "./chat-queued-event.service";
import { activateUsageAllowanceWindowsForRun } from "./usage-allowance.service";
import {
  bindMorningBriefScheduleClaimRun,
  morningBriefScheduleClaimBound,
  morningBriefScheduleClaimSuperseded,
} from "./morning-brief-schedule-claim.service";
import { requestPiMemoryStage1DayForAdmittedRun } from "./pi-memory-stage1-schedule.service";
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
import { replaceChatEvent, insertChatEvent } from "./chat-event.service";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
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

type AdmittedClaimRun = {
  readonly kind: "admitted";
  readonly validatedThreadSession: Awaited<
    ReturnType<typeof validateThreadSessionSnapshot>
  >;
  readonly validatedAccountIdentity: string | null;
  readonly queueFirstClaim: Extract<
    Awaited<ReturnType<typeof claimQueueFirstRunAssociation>>,
    { kind: "claimed" }
  >;
};

type ClaimRunAdmission =
  | AdmittedClaimRun
  | Exclude<AtomicLaunchCommitCompletion["result"], { kind: "pending" }>;

/** Revalidate only the captured admission facts under the pending transaction. */
async function validateClaimedRunAdmission(
  tx: Tx,
  claim: ThreadClaim,
  context: RunContext,
  preparedCommit: PreparedCommitPreparedLaunchArgs,
  timing: ApiDispatchTimingCollector,
): Promise<ClaimRunAdmission> {
  const { input, identity, launch } = context;
  const { admissionTiming } = preparedCommit;
  const validateOfficialAdmission = () => {
    return timing.measure(
      "api_dispatch_validate_official_workflow_admission",
      "nested",
      () => {
        return validateOfficialWorkflowRunForInsert(tx, {
          observation: input.context.officialWorkflowRun,
          orgId: input.args.orgId,
          userId: input.args.userId,
          agentId: input.context.resolved.agentId,
          automationId: input.args.agentRunMetadata?.workflowAutomationId,
          runStorageMounts: launch.runStorageMounts,
          allowMissingMountsForFailedRun: false,
        });
      },
    );
  };
  const officialFailure = input.context.officialWorkflowRun
    ? await admissionTiming.measureLeaf(
        "official_workflow",
        validateOfficialAdmission,
      )
    : await validateOfficialAdmission();
  if (officialFailure) {
    return conflict(officialFailure.message);
  }
  const validatedThreadSession = await admissionTiming.measureLeaf(
    "thread_session",
    () => {
      return validateThreadSessionSnapshot(tx, {
        createArgs: input.args,
        identity,
        timing: timing,
      });
    },
  );
  const subscription = await validateCapturedSubscriptionAccount(
    tx,
    preparedCommit,
  );
  if (subscription && !("identity" in subscription)) {
    return subscription;
  }
  const association = input.args.queueFirstAssociation;
  const modelPin = input.args.agentRunModelPin;
  if (
    !association ||
    association.threadId !== claim.chatThreadId ||
    !modelPin
  ) {
    throw new Error(
      "Chat run commit requires its captured input association and model pin",
    );
  }
  const queueFirstClaim = await admissionTiming.measureLeaf(
    "queue_first",
    async () => {
      const admission = await resolveQueueFirstRunAdmission(tx, {
        association,
        sessionSnapshotState: validatedThreadSession
          ? "current"
          : "unvalidated",
        timing: timing,
      });
      return await claimQueueFirstRunAssociation(tx, {
        ...association,
        admission,
        runId: identity.runId,
        selectedModel: modelPin.selectedModel,
        ...(input.args.codexServiceTier
          ? {
              serviceTier:
                input.args.codexServiceTier === "fast"
                  ? ("priority" as const)
                  : ("ultrafast" as const),
            }
          : {}),
        timing: timing,
      });
    },
  );
  if (queueFirstClaim.kind === "lost") {
    return { kind: "queue-first-claim-lost" };
  }
  return {
    kind: "admitted",
    validatedThreadSession,
    validatedAccountIdentity: subscription?.identity ?? null,
    queueFirstClaim,
  };
}

/** Producer ownership is persisted with the run rather than carried as a callback. */
async function persistClaimProducerBinding(
  tx: Tx,
  context: RunContext,
  runId: string,
): Promise<void> {
  const producer = context.producerBinding;
  if (producer?.kind === "automation") {
    await bindMorningBriefScheduleClaimRun(tx, {
      queueEventId: producer.queueEventId,
      runId,
    });
  } else if (producer?.kind === "reassign-agent") {
    await tx
      .update(chatThreads)
      .set({ agentId: producer.agentId })
      .where(
        and(
          eq(chatThreads.id, producer.threadId),
          eq(chatThreads.userId, producer.userId),
          eq(chatThreads.agentId, producer.expectedAgentId),
        ),
      );
    await tx.execute(
      chatThreadEventInsertSql({
        kind: "sort_touched",
        chatThreadId: producer.threadId,
        userId: producer.userId,
        orgId: producer.orgId,
        agentId: producer.agentId,
        reassignedAgentId: producer.agentId,
      }),
    );
  }
}

/** All writes here use the parent's one pending transaction. */
async function persistClaimedRun(
  tx: Tx,
  context: RunContext,
  preparedCommit: PreparedCommitPreparedLaunchArgs,
  admission: AdmittedClaimRun,
  timing: ApiDispatchTimingCollector,
): Promise<Extract<AtomicLaunchCommitResult, { kind: "pending" }>> {
  const { input, identity, launch } = context;
  const { admissionTiming, persistence } = preparedCommit;
  const persisted = await admissionTiming.measureLeaf(
    "persistence",
    async () => {
      const capabilities = input.enforceBuiltInCredits
        ? await loadOrgPlanCapabilities(tx, input.args.orgId, {
            forUpdate: true,
          })
        : null;
      const creditAdmitted =
        input.enforceBuiltInCredits &&
        isFreePlanForCreditAdmission(capabilities?.planKey);
      if (input.args.threadSessionResolution?.resetNativeSession) {
        await tx
          .update(agentSessions)
          .set({
            agentId: input.context.resolved.agentId,
            conversationId: null,
            storageMounts: [...launch.sessionStorageMounts],
          })
          .where(eq(agentSessions.id, identity.sessionId));
      }
      const rows = {
        tx,
        commit: preparedCommit,
        payload: persistence.payload,
        validatedThreadSession: admission.validatedThreadSession,
        validatedAccountIdentity: admission.validatedAccountIdentity,
      };
      const ctes = buildAtomicLaunchCteContext(rows, creditAdmitted);
      const rowsPersisted = await timing.measure(
        "api_dispatch_persist_atomic_launch",
        "nested",
        () => {
          return persistPendingAtomicLaunch(rows, ctes);
        },
      );
      await persistClaimProducerBinding(tx, context, rowsPersisted.run.id);
      await requestPiMemoryStage1DayForAdmittedRun(tx, rowsPersisted.run.id);
      const threadSessionBinding =
        input.args.chatThreadId && !admission.validatedThreadSession
          ? await persistThreadSessionBinding(tx, {
              chatThreadId: input.args.chatThreadId,
              identity,
              resolution: input.args.threadSessionResolution,
              timing: timing,
            })
          : rowsPersisted.threadSessionBinding;
      return { ...rowsPersisted, threadSessionBinding };
    },
  );
  if (isBuiltInModelProviderType(input.context.modelProvider?.type)) {
    await admissionTiming.measureLeaf("usage_allowance", async () => {
      const startedAt = now();
      await activateUsageAllowanceWindowsForRun(tx, {
        orgId: input.args.orgId,
        runId: persisted.run.id,
        runCreatedAt: persisted.run.createdAt,
        refresh: context.allowanceRefresh,
      });
      timing.recordElapsed(
        "api_dispatch_activate_usage_allowance_windows",
        "nested",
        startedAt,
      );
    });
  }
  return {
    ...persisted,
    runnerJobPayload: persistence.payload,
    runContextSnapshot: launch.runContextSnapshot,
    queueFirstClaim: admission.queueFirstClaim,
  };
}

/**
 * Reuse this outer graph for one organization pass. Each successful claim gets
 * one isolated child graph in the same request Store. The cursor advances over
 * selected work; it never retries a failed launch within this pass.
 */
/**
 * Replace an unconsumed queued input with `input.rejected` and append its
 * visible error. Returns null when the input was already consumed.
 */
async function appendQueueHeadRejection(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly errorMarker: string;
    readonly displayError: string;
  },
): Promise<{
  readonly assistantEventId: string;
  readonly contextType: string | null;
  readonly contextId: string | null;
} | null> {
  const [head] = await tx
    .select({
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.chatThreadId),
      ),
    )
    .limit(1);
  if (!head?.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const rejectedAt = new Date(
    Math.max(nowDate().getTime(), head.createdAt.getTime() + 1),
  );
  const rejected = await replaceChatEvent(tx, args.eventId, {
    chatThreadId: args.chatThreadId,
    eventType: "input.rejected",
    userMessage: head.userMessage,
    runId: null,
    error: args.errorMarker,
    createdAt: rejectedAt,
  });
  if (!rejected) {
    return null;
  }
  const assistant = await insertChatEvent(tx, {
    chatThreadId: args.chatThreadId,
    eventType: "output.error",
    content: args.displayError,
    runId: null,
    error: args.errorMarker,
    createdAt: new Date(rejectedAt.getTime() + 1),
  });
  if (!assistant) {
    throw new Error("Failed to append queued input rejection");
  }
  await touchChatThreadLastMessageAt(
    tx,
    args.chatThreadId,
    assistant.createdAt,
  );
  return {
    assistantEventId: assistant.id,
    contextType: head.contextType,
    contextId: head.contextId,
  };
}

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
    ({ set }, claim: LeasedThreadClaim, signal: AbortSignal): void => {
      const { pick$: nextPick$ } = createPickObjects(
        claim.orgId,
        claim.chatThreadId,
      );
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
        set(scheduleThreadPick$, claim, signal);
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
      const rejected = await set(writeDb$).transaction(async (tx) => {
        const appended = await appendQueueHeadRejection(tx, {
          chatThreadId: head.chatThreadId,
          eventId: head.id,
          errorMarker: error.code.toLowerCase(),
          displayError,
        });
        if (lease) {
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
          if (!released) {
            tx.rollback();
          }
        }
        return appended;
      });
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
      const database = set(writeDb$);
      const commit: CommitPreparedLaunchArgs = {
        db: database,
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
          const result = await database.transaction(
            async (tx): Promise<AtomicLaunchCommitCompletion["result"]> => {
              admissionTiming.transactionStarted();
              await acquireOfficialWorkflowRunCatalogAdmissionLock(
                tx,
                input.context.officialWorkflowRun,
              );
              // Keep credit-plan acquisition ahead of workflow/automation locks.
              if (
                input.context.officialWorkflowRun &&
                input.enforceBuiltInCredits
              ) {
                await loadOrgPlanCapabilities(tx, input.args.orgId, {
                  forUpdate: true,
                });
              }
              admissionTiming.admissionStarted();
              const admission = await validateClaimedRunAdmission(
                tx,
                claim,
                context,
                preparedCommit,
                timing.run,
              );
              if (!("kind" in admission) || admission.kind !== "admitted") {
                admissionTiming.callbackFinished();
                return admission;
              }
              // Fence the lease before the run writes. Admission above already
              // appended the input claim (locking the thread's event sequence
              // row, which every enqueue takes first) and took the
              // automation/plan locks that enqueue takes before its upsert.
              const [fenced] = await tx
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
              if (!fenced) {
                throw new Error(
                  "Chat thread claim was lost before the pending commit",
                );
              }
              const pending = await persistClaimedRun(
                tx,
                context,
                preparedCommit,
                admission,
                timing.run,
              );
              // This unique insert is deliberately the final SQL statement.
              // A concurrent active run rolls the entire pending commit back.
              await tx.insert(activeAgentRuns).values({
                runId: pending.run.id,
                orgId: input.args.orgId,
                userId: input.args.userId,
                chatThreadId: claim.chatThreadId,
                lastHeartbeatAt: pending.run.createdAt,
              });
              admissionTiming.callbackFinished();
              return pending;
            },
          );
          const transactionReturnedAt = now();
          await admissionTiming.finish(admissionAttemptOutcome(result));
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
        if (await morningBriefScheduleClaimBound(database, pending.runId)) {
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
            if (
              !locked ||
              (await morningBriefScheduleClaimSuperseded(tx, pending.runId))
            ) {
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
      const claimed = createClaimRunObjects({
        orgId: claim.orgId,
        chatThreadId: claim.chatThreadId,
        claimId: claim.claimId,
        pickStartedAt: claim.pickStartedAt,
      });
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
