import {
  readPiInferenceLifecycle,
  assertPiInferenceApiFailure,
  assertPiInferencePublication,
} from "./pi-inference-lifecycle.service";
import { command } from "ccstate";
import type { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  runStatusSchema,
  type RunResult,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import type { Tx } from "../../lib/db-types";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { piLangfuseDebugUserId } from "../../lib/pi-langfuse-debug";
import { recordPiLangfuseRunEndToEnd } from "../../lib/pi-langfuse-tracing";
import { now, nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$, type Db } from "../external/db";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import {
  publishChatThreadDetailChangedSafely,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import { safeSync, settle, tapError } from "../utils";
import {
  chatCallbackIdForRun,
  dispatchFailedRunCallbacks,
  dispatchRunCallbacks$,
  undeliveredChatCallbackIdForRun,
} from "./agent-run-callback.service";
import { drainChatThreadQueueForRun$ } from "./chat-thread-queue-drain.service";
import {
  finalizeActiveInputDelivery,
  type FinalizeActiveInputDeliveryResult,
} from "./active-input-delivery.service";
import { lockChatQueueThread } from "./chat-event-queue.service";
import { projectLegacyCheckpointStorage } from "./storage-legacy-projection.service";
import { maybeEmitRunUsageEvent$ } from "./chat-usage-event.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { lockAgentRunCheckpointLifecycle } from "./agent-run-checkpoint-lifecycle-lock.service";
import {
  type AgentCheckpointErrorResponse,
  type AgentCheckpointInput,
  type PreparedAgentCheckpoint,
  persistAgentCheckpointInTransaction,
  prepareAgentCheckpointPersistence$,
} from "./agent-webhook-checkpoints.service";
import { lockPiMemoryCandidateStorage } from "./pi-memory-stage1-candidate.service";
import { transitionAgentRunsToTerminal } from "./agent-run-terminal-transition.service";
import {
  logAgentRunFailure,
  type AgentRunFailureLogSnapshot,
} from "./agent-run-failure-log.service";

type WebhookCompleteBody = z.infer<
  typeof webhookCompleteContract.complete.body
>;
type TerminalStatus = "completed" | "failed";

interface CompleteAgentRunInput {
  readonly inferenceOwnerEpoch?: number;
  readonly auth: SandboxAuth;
  readonly body: WebhookCompleteBody;
  readonly allowCheckpointlessSuccess?: boolean;
  readonly executionOwner?: "api-first";
}

export interface TerminalSideEffectsInput {
  readonly kind: "terminal";
  readonly runId: string;
  readonly orgId: string;
  readonly status: TerminalStatus;
  readonly error?: string;
  readonly deliveryNotification?: {
    readonly userId: string;
    readonly chatThreadId: string;
    readonly chatEventsAppended: boolean;
  };
}

export interface CancellationRecoverySideEffectsInput {
  readonly kind: "cancellation-recovery";
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string | null;
  readonly chatEventsAppended: boolean;
}

export interface DeliveryFinalizationSideEffectsInput {
  readonly kind: "delivery-finalization";
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly chatEventsAppended: boolean;
}

export type CompleteSideEffectsInput = (
  | TerminalSideEffectsInput
  | CancellationRecoverySideEffectsInput
  | DeliveryFinalizationSideEffectsInput
) & { readonly cleanupPiApiFirstTurn?: true };

export type DispatchCompleteSideEffectsInput = CompleteSideEffectsInput & {
  readonly apiStartTime?: number;
  readonly skipChatCallback?: true;
  readonly chatThreadQueueHandled?: true;
};

interface CompletionSuccessResponse {
  readonly status: 200;
  readonly body: {
    readonly success: true;
    readonly status: TerminalStatus;
  };
  readonly sideEffects?: CompleteSideEffectsInput;
}

type CompletionResponse =
  | CompletionSuccessResponse
  | AgentCheckpointErrorResponse;

interface RunRecord extends AgentRunFailureLogSnapshot {
  readonly apiStartedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly error: string | null;
  readonly orgId: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly userId: string;
  readonly chatThreadId: string | null;
  readonly triggerSource: string | null;
  readonly launchSnapshot: (typeof agentRuns.$inferSelect)["launchSnapshot"];
  readonly langfuseTraceEnabled: boolean;
}

interface PreparedCompletion {
  readonly status: TerminalStatus;
  readonly result?: RunResult;
  readonly error?: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly failureKind?: "missing-checkpoint" | "reported";
}

interface CompletionCommit {
  readonly run: RunRecord;
  readonly transitioned: boolean;
  readonly responseStatus: TerminalStatus;
  readonly transitionError?: string;
  readonly transitionFailureKind?: PreparedCompletion["failureKind"];
  readonly transitionFailureReason?: RunFailureReasonToken;
  readonly finalization: FinalizeActiveInputDeliveryResult;
}

type CompletionTransactionResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "retry"; readonly chatThreadId: string | null }
  | {
      readonly kind: "response";
      readonly response: AgentCheckpointErrorResponse;
    }
  | { readonly kind: "committed"; readonly commit: CompletionCommit };

const L = logger("webhook:complete");

function logAgentRunCompletionOutcome(
  input: CompleteAgentRunInput,
  commit: CompletionCommit,
): void {
  if (commit.responseStatus === "completed") {
    L.debug("Run completed successfully", { runId: input.body.runId });
    return;
  }
  if (commit.transitionFailureKind === "missing-checkpoint") {
    L.warn("Run failed because checkpoint was not found", {
      runId: input.body.runId,
      error: commit.transitionError,
    });
    return;
  }
  logAgentRunFailure({
    runId: input.body.runId,
    exitCode: input.body.exitCode,
    error: commit.transitionError,
    failureReason: commit.transitionFailureReason,
    executionOwner: input.executionOwner ?? "sandbox",
    run: commit.run,
  });
}

function checkpointInputForCompletion(
  input: CompleteAgentRunInput,
): AgentCheckpointInput | null {
  if (!input.body.checkpoint) {
    return null;
  }
  return {
    auth: input.auth,
    ...(input.inferenceOwnerEpoch === undefined
      ? {}
      : { inferenceOwnerEpoch: input.inferenceOwnerEpoch }),
    body: {
      ...input.body.checkpoint,
      runId: input.body.runId,
    },
  };
}

function buildRunResult(
  checkpoint: Pick<
    typeof checkpoints.$inferSelect,
    "id" | "conversationId" | "storageMounts"
  >,
  sessionId: string | undefined,
): RunResult {
  if (checkpoint.storageMounts === null) {
    throw new Error(
      `Checkpoint "${checkpoint.id}" is missing canonical Storage mounts`,
    );
  }
  const canonicalProjection = projectLegacyCheckpointStorage(
    checkpoint.storageMounts,
  );
  const artifact = canonicalProjection.artifactVersions ?? undefined;
  const volumeVersions =
    canonicalProjection.volumeVersionsSnapshot?.versions ?? undefined;

  return {
    checkpointId: checkpoint.id,
    agentSessionId: sessionId ?? checkpoint.conversationId,
    conversationId: checkpoint.conversationId,
    ...(artifact ? { artifact } : {}),
    ...(volumeVersions ? { volumes: volumeVersions } : {}),
  };
}

async function persistLastEventSequence(
  db: Tx,
  runId: string,
  userId: string,
  lastEventSequence: number,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({
      lastEventSequence: sql`greatest(coalesce(${agentRuns.lastEventSequence}, -1), ${lastEventSequence})`,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)));
}

async function loadCompletionRun(
  db: Db,
  input: CompleteAgentRunInput,
): Promise<RunRecord | null> {
  const [run] = await db
    .select({
      apiStartedAt: agentRuns.apiStartedAt,
      error: agentRuns.error,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      status: agentRuns.status,
      userId: agentRuns.userId,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
      launchSnapshot: agentRuns.launchSnapshot,
      langfuseTraceEnabled: agentRuns.langfuseTraceEnabled,
      modelProvider: agentRuns.modelProvider,
      modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
      ),
    )
    .limit(1);
  if (!run) {
    return null;
  }
  return { ...run, status: runStatusSchema.parse(run.status) };
}

async function prepareCompletion(
  db: Tx,
  input: CompleteAgentRunInput,
  sessionId: string,
  signal: AbortSignal,
): Promise<PreparedCompletion> {
  if (input.body.exitCode !== 0) {
    const error =
      input.body.error?.trim() || "Run failed without error message";
    return {
      status: "failed",
      error,
      failureReason: input.body.failureReason,
      failureKind: "reported",
    };
  }
  const [checkpoint] = await db
    .select({
      id: checkpoints.id,
      conversationId: checkpoints.conversationId,
      storageMounts: checkpoints.storageMounts,
    })
    .from(checkpoints)
    .where(eq(checkpoints.runId, input.body.runId))
    .limit(1);
  signal.throwIfAborted();
  if (!checkpoint) {
    if (input.allowCheckpointlessSuccess) {
      return { status: "completed" };
    }
    return {
      status: "failed",
      error: "Checkpoint for run not found",
      failureKind: "missing-checkpoint",
    };
  }
  return {
    status: "completed",
    result: buildRunResult(checkpoint, sessionId),
  };
}

async function lockCompletionRun(
  tx: Tx,
  input: CompleteAgentRunInput,
): Promise<RunRecord | null> {
  const [run] = await tx
    .select({
      apiStartedAt: agentRuns.apiStartedAt,
      error: agentRuns.error,
      orgId: agentRuns.orgId,
      sessionId: agentRuns.sessionId,
      status: agentRuns.status,
      userId: agentRuns.userId,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
      launchSnapshot: agentRuns.launchSnapshot,
      langfuseTraceEnabled: agentRuns.langfuseTraceEnabled,
      modelProvider: agentRuns.modelProvider,
      modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeProvider: agentRuns.modelRuntimeProvider,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, input.body.runId),
        eq(agentRuns.userId, input.auth.userId),
      ),
    )
    .for("update", { of: agentRuns })
    .limit(1);
  if (!run) {
    return null;
  }
  const lifecycle = await readPiInferenceLifecycle(
    tx,
    input.body.runId,
    run.launchSnapshot,
  );
  const sandboxFence = input.auth.piSandbox;
  if (sandboxFence) {
    if (
      lifecycle?.lease?.claimedOwnerEpoch !== sandboxFence.ownerEpoch ||
      lifecycle.lease.claimedGeneration !== sandboxFence.generation
    ) {
      throw new Error("Stale Pi Sandbox completion");
    }
    if (lifecycle.inference.phase !== "terminal") {
      assertPiInferencePublication(lifecycle, sandboxFence.ownerEpoch);
    }
  } else if (
    input.executionOwner === "api-first" &&
    input.body.exitCode !== 0
  ) {
    assertPiInferenceApiFailure(lifecycle, input.inferenceOwnerEpoch);
  } else {
    assertPiInferencePublication(lifecycle, input.inferenceOwnerEpoch);
  }

  return { ...run, status: runStatusSchema.parse(run.status) };
}

async function applyCancelledCompletionMetadata(
  tx: Tx,
  input: CompleteAgentRunInput,
  run: RunRecord,
): Promise<void> {
  // Guest and host completion may both arrive after cancellation. Preserve the
  // first terminal metadata just like the completed/failed transition paths.
  const update = {
    ...(run.cancellationRecoveryCompleted === false
      ? { cancellationRecoveryCompleted: true }
      : {}),
    ...(input.body.sandboxId !== undefined
      ? {
          sandboxId: sql`coalesce(${agentRuns.sandboxId}, ${input.body.sandboxId})`,
        }
      : {}),
    ...(input.body.sandboxReuseResult !== undefined
      ? {
          sandboxReuseResult: sql`coalesce(${agentRuns.sandboxReuseResult}, ${input.body.sandboxReuseResult})`,
        }
      : {}),
    ...(input.body.workspaceReuseResult !== undefined
      ? {
          workspaceReuseResult: sql`coalesce(${agentRuns.workspaceReuseResult}, ${input.body.workspaceReuseResult})`,
        }
      : {}),
  };
  if (Object.keys(update).length > 0) {
    await tx
      .update(agentRuns)
      .set(update)
      .where(
        and(
          eq(agentRuns.id, input.body.runId),
          eq(agentRuns.userId, input.auth.userId),
          eq(agentRuns.status, "cancelled"),
        ),
      );
  }
}

async function applyTerminalCompletion(
  tx: Tx,
  input: CompleteAgentRunInput,
  run: RunRecord,
  prepared: PreparedCompletion,
  completedAt: Date,
): Promise<void> {
  if (
    run.launchSnapshot?.framework === "pi" &&
    prepared.status === "completed"
  ) {
    const conversationId = prepared.result?.conversationId;
    if (!conversationId) {
      throw new Error("Completed Pi run is missing its canonical conversation");
    }
    const [session] = await tx
      .update(agentSessions)
      .set({ conversationId, updatedAt: completedAt })
      .where(eq(agentSessions.id, run.sessionId))
      .returning({ id: agentSessions.id });
    if (!session) {
      throw new Error("Completed Pi run is missing its AgentSession");
    }
  }

  const [updated] = await transitionAgentRunsToTerminal(tx, {
    values: {
      status: prepared.status,
      completedAt,
      ...(input.executionOwner === "api-first"
        ? { runnerCancellationMode: "hard" as const }
        : {}),
      ...(prepared.error !== undefined ? { error: prepared.error } : {}),
      failureReason: prepared.failureReason ?? null,
      ...(prepared.result !== undefined ? { result: prepared.result } : {}),
      sandboxId: input.body.sandboxId,
      sandboxReuseResult: input.body.sandboxReuseResult,
      workspaceReuseResult: input.body.workspaceReuseResult,
    },
    conditions: [
      eq(agentRuns.id, input.body.runId),
      eq(agentRuns.userId, input.auth.userId),
      inArray(agentRuns.status, ["pending", "running"]),
    ],
  });
  if (!updated) {
    throw new Error("Locked agent run lost its terminal transition");
  }
}

function noActiveInputFinalization(): FinalizeActiveInputDeliveryResult {
  return {
    finalized: false,
    chatEventsAppended: false,
  };
}

interface CompletionTransitionContext {
  readonly checkpointInput: AgentCheckpointInput | null;
  readonly checkpointPreparation: PreparedAgentCheckpoint | null;
  readonly expectedChatThreadId: string | null;
}

async function completeActiveAgentRunTransition(
  tx: Tx,
  input: CompleteAgentRunInput,
  run: RunRecord,
  prepared: PreparedCompletion,
  finalization: FinalizeActiveInputDeliveryResult,
): Promise<CompletionTransactionResult> {
  const completedAt = nowDate();
  await applyTerminalCompletion(tx, input, run, prepared, completedAt);
  return {
    kind: "committed",
    commit: {
      run,
      transitioned: true,
      responseStatus: prepared.status,
      transitionError: prepared.error,
      transitionFailureKind: prepared.failureKind,
      transitionFailureReason: prepared.failureReason,
      finalization,
    },
  };
}

async function lockCompletionPiMemoryStorage(
  tx: Tx,
  run: RunRecord,
): Promise<void> {
  if (run.launchSnapshot?.framework === "pi") {
    await lockPiMemoryCandidateStorage(tx, run);
  }
}

function persistedTerminalError(
  run: RunRecord,
): { readonly transitionError: string } | Record<string, never> {
  if (run.status !== "failed") {
    return {};
  }
  return {
    transitionError: run.error?.trim() || "Run failed without error message",
  };
}

async function completeAgentRunTransition(
  tx: Tx,
  input: CompleteAgentRunInput,
  context: CompletionTransitionContext,
  signal: AbortSignal,
): Promise<CompletionTransactionResult> {
  const { checkpointInput, checkpointPreparation, expectedChatThreadId } =
    context;
  const threadLocked =
    expectedChatThreadId === null
      ? false
      : await lockChatQueueThread(tx, expectedChatThreadId);
  const run = await lockCompletionRun(tx, input);
  if (!run) {
    return { kind: "not-found" };
  }
  if (run.chatThreadId !== expectedChatThreadId) {
    return { kind: "retry", chatThreadId: run.chatThreadId };
  }
  if (expectedChatThreadId !== null && !threadLocked) {
    throw new Error("Agent run retained a missing chat thread");
  }
  if (run.status === "timeout") {
    return {
      kind: "committed",
      commit: {
        run,
        transitioned: false,
        responseStatus: "failed",
        finalization: noActiveInputFinalization(),
      },
    };
  }
  await lockCompletionPiMemoryStorage(tx, run);
  signal.throwIfAborted();
  if (checkpointInput) {
    if (!checkpointPreparation) {
      throw new Error("Included agent checkpoint was not prepared");
    }
    const checkpointResult = await persistAgentCheckpointInTransaction(
      tx,
      checkpointInput,
      checkpointPreparation,
      signal,
      { source: "combined-completion" },
    );
    if (checkpointResult.status !== 200) {
      return { kind: "response", response: checkpointResult };
    }
  }
  const canTransition = run.status === "pending" || run.status === "running";
  const prepared = canTransition
    ? await prepareCompletion(tx, input, run.sessionId, signal)
    : null;
  signal.throwIfAborted();
  if (input.body.lastEventSequence !== undefined) {
    await persistLastEventSequence(
      tx,
      input.body.runId,
      input.auth.userId,
      input.body.lastEventSequence,
    );
  }
  const finalization =
    run.chatThreadId === null
      ? noActiveInputFinalization()
      : await finalizeActiveInputDelivery(tx, {
          runId: input.body.runId,
          chatThreadId: run.chatThreadId,
          deliveredDeliveryIds: new Set(
            input.body.activeInputDeliveryIds ?? [],
          ),
        });
  if (canTransition) {
    if (!prepared) {
      throw new Error("Active agent run completion was not prepared");
    }
    return completeActiveAgentRunTransition(
      tx,
      input,
      run,
      prepared,
      finalization,
    );
  }
  if (run.status === "cancelled") {
    await applyCancelledCompletionMetadata(tx, input, run);
  }
  return {
    kind: "committed",
    commit: {
      run,
      transitioned: false,
      responseStatus: run.status === "completed" ? "completed" : "failed",
      ...persistedTerminalError(run),
      finalization,
    },
  };
}

function completionResponse(
  runId: string,
  commit: CompletionCommit,
  redriveTerminalChatCallback: boolean,
): CompletionResponse {
  let sideEffects: CompleteSideEffectsInput | undefined;
  const piCleanup =
    commit.run.launchSnapshot?.framework === "pi"
      ? ({ cleanupPiApiFirstTurn: true } as const)
      : {};
  if (commit.transitioned || redriveTerminalChatCallback) {
    sideEffects = {
      kind: "terminal",
      runId,
      orgId: commit.run.orgId,
      status: commit.responseStatus,
      ...(commit.transitionError !== undefined
        ? { error: commit.transitionError }
        : {}),
      ...(commit.run.chatThreadId !== null
        ? {
            deliveryNotification: {
              userId: commit.run.userId,
              chatThreadId: commit.run.chatThreadId,
              chatEventsAppended: commit.finalization.chatEventsAppended,
            },
          }
        : {}),
      ...piCleanup,
    };
  } else if (
    commit.run.status === "cancelled" &&
    (commit.run.cancellationRecoveryCompleted !== null ||
      commit.finalization.finalized)
  ) {
    sideEffects = {
      kind: "cancellation-recovery",
      runId,
      orgId: commit.run.orgId,
      userId: commit.run.userId,
      chatThreadId: commit.run.chatThreadId,
      chatEventsAppended: commit.finalization.chatEventsAppended,
      ...piCleanup,
    };
  } else if (
    commit.finalization.finalized &&
    commit.run.chatThreadId !== null
  ) {
    sideEffects = {
      kind: "delivery-finalization",
      runId,
      orgId: commit.run.orgId,
      userId: commit.run.userId,
      chatThreadId: commit.run.chatThreadId,
      chatEventsAppended: commit.finalization.chatEventsAppended,
      ...piCleanup,
    };
  }
  return {
    status: 200,
    body: { success: true, status: commit.responseStatus },
    ...(sideEffects ? { sideEffects } : {}),
  };
}

function settledRunCompletionResponse(run: RunRecord): CompletionResponse {
  return {
    status: 200,
    body: {
      success: true,
      status: run.status === "completed" ? "completed" : "failed",
    },
  };
}

export type RequiredTerminalChatCallbackResult =
  | { readonly success: true; readonly chatThreadQueueHandled: boolean }
  | {
      readonly success: false;
      readonly chatThreadQueueHandled: boolean;
      readonly error: string;
    };

/**
 * Finish the canonical chat projection before the completion webhook is
 * acknowledged. Other callbacks and accounting remain background side
 * effects, but this durable callback owns the lifecycle marker and thread
 * queue wakeup.
 */
export const dispatchRequiredTerminalChatCallback$ = command(
  async (
    { set },
    input: TerminalSideEffectsInput & {
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<RequiredTerminalChatCallbackResult> => {
    const db = set(writeDb$);
    const chatCallbackId = await undeliveredChatCallbackIdForRun(
      db,
      input.runId,
    );
    signal.throwIfAborted();
    if (chatCallbackId === undefined) {
      return { success: true, chatThreadQueueHandled: false };
    }

    const [callbackResult] = await set(
      dispatchRunCallbacks$,
      {
        db,
        runId: input.runId,
        status: input.status,
        error: input.error,
        redriveChatCallbackId: chatCallbackId,
        redriveUndeliveredChatCallbackOnly: true,
        awaitTerminalChatProjection: true,
      },
      signal,
    );
    signal.throwIfAborted();
    if (callbackResult?.success) {
      return { success: true, chatThreadQueueHandled: true };
    }
    if (
      callbackResult === undefined &&
      (await undeliveredChatCallbackIdForRun(db, input.runId)) === undefined
    ) {
      signal.throwIfAborted();
      return { success: true, chatThreadQueueHandled: false };
    }

    const drained = await settle(
      set(
        drainChatThreadQueueForRun$,
        {
          runId: input.runId,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          apiStartTime: input.apiStartTime,
        },
        signal,
      ),
    );
    signal.throwIfAborted();
    if (!drained.ok) {
      L.error("Failed to drain chat thread queue after callback failure", {
        runId: input.runId,
        error: drained.error,
      });
    }
    return {
      success: false,
      chatThreadQueueHandled: drained.ok,
      error: callbackResult?.error ?? "Canonical terminal chat callback failed",
    };
  },
);

const dispatchTerminalCompleteSideEffects$ = command(
  async (
    { set },
    input: TerminalSideEffectsInput & {
      readonly apiStartTime: number;
      readonly skipChatCallback?: true;
      readonly chatThreadQueueHandled?: true;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    if (input.deliveryNotification?.chatEventsAppended) {
      await publishChatThreadMessageCreatedSafely({
        userId: input.deliveryNotification.userId,
        orgId: input.orgId,
        threadId: input.deliveryNotification.chatThreadId,
      });
      signal.throwIfAborted();
    }
    const callbackStatus =
      input.status === "completed" ? "completed" : "failed";
    const chatCallbackId = input.skipChatCallback
      ? undefined
      : await chatCallbackIdForRun(db, input.runId);
    signal.throwIfAborted();
    const callbackResults = await tapError(
      set(
        dispatchRunCallbacks$,
        {
          db,
          runId: input.runId,
          status: callbackStatus,
          error: input.error,
          skipChatCallback: input.skipChatCallback,
        },
        signal,
      ),
      (error) => {
        L.error("Failed to dispatch terminal callbacks", {
          runId: input.runId,
          error,
        });
      },
    );
    signal.throwIfAborted();

    const chatCallbackDrained =
      input.chatThreadQueueHandled === true ||
      callbackResults?.some((result) => {
        return result.callbackId === chatCallbackId && result.success;
      });
    if (!chatCallbackDrained) {
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: input.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime: input.apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    await set(processOrgUsageEvents$, input.orgId, signal);
    signal.throwIfAborted();

    await tapError(
      set(maybeEmitRunUsageEvent$, input.runId, signal),
      (error) => {
        L.error("Failed to emit chat usage message after run completion", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);

export const dispatchCompleteSideEffectsCore$ = command(
  async (
    { set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const apiStartTime = input.apiStartTime ?? now();
    if (input.kind === "cancellation-recovery") {
      if (input.chatThreadId !== null) {
        await publishChatThreadDetailChangedSafely(
          input.userId,
          input.chatThreadId,
        );
        signal.throwIfAborted();
        if (input.chatEventsAppended) {
          await publishChatThreadMessageCreatedSafely({
            userId: input.userId,
            orgId: input.orgId,
            threadId: input.chatThreadId,
          });
          signal.throwIfAborted();
        }
      }
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: input.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue after recovery", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
      return;
    }
    if (input.kind === "delivery-finalization") {
      if (input.chatEventsAppended) {
        await publishChatThreadMessageCreatedSafely({
          userId: input.userId,
          orgId: input.orgId,
          threadId: input.chatThreadId,
        });
        signal.throwIfAborted();
      }
      await tapError(
        set(
          drainChatThreadQueueForRun$,
          {
            runId: input.runId,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
            apiStartTime,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain chat thread queue after delivery", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
      return;
    }
    await set(
      dispatchTerminalCompleteSideEffects$,
      { ...input, apiStartTime },
      signal,
    );
  },
);

export const completeAgentRun$ = command(
  async (
    { set },
    input: CompleteAgentRunInput,
    signal: AbortSignal,
  ): Promise<CompletionResponse> => {
    const db = set(writeDb$);
    const initialRun = await loadCompletionRun(db, input);
    signal.throwIfAborted();
    if (!initialRun) {
      return notFound("Agent run not found");
    }
    if (initialRun.status === "timeout") {
      return settledRunCompletionResponse(initialRun);
    }
    const checkpointInput = checkpointInputForCompletion(input);
    let checkpointPreparation: PreparedAgentCheckpoint | null = null;
    if (checkpointInput) {
      const preparation = await set(
        prepareAgentCheckpointPersistence$,
        checkpointInput,
        { source: "combined-completion" },
        signal,
      );
      if (!preparation.ok) {
        return preparation.response;
      }
      checkpointPreparation = preparation.prepared;
    }
    let expectedChatThreadId = initialRun.chatThreadId;
    let commit: CompletionCommit;
    while (true) {
      const result = await db.transaction(async (tx) => {
        await lockAgentRunCheckpointLifecycle(tx, input.body.runId);
        signal.throwIfAborted();
        return await completeAgentRunTransition(
          tx,
          input,
          {
            checkpointInput,
            checkpointPreparation,
            expectedChatThreadId,
          },
          signal,
        );
      });
      signal.throwIfAborted();
      if (result.kind === "retry") {
        expectedChatThreadId = result.chatThreadId;
        continue;
      }
      if (result.kind === "not-found") {
        return settledRunCompletionResponse(initialRun);
      }
      if (result.kind === "response") {
        return result.response;
      }
      commit = result.commit;
      break;
    }

    if (commit.transitioned) {
      const terminalCommittedAt = now();
      const terminalCommittedAtIso = new Date(
        terminalCommittedAt,
      ).toISOString();
      if (
        commit.run.launchSnapshot?.framework === "pi" &&
        commit.run.langfuseTraceEnabled
      ) {
        safeSync(() => {
          recordPiLangfuseRunEndToEnd({
            enabled: true,
            runId: input.body.runId,
            sessionId: commit.run.sessionId,
            userId: piLangfuseDebugUserId(commit.run.userId),
            apiStartedAt: commit.run.apiStartedAt?.getTime(),
            terminalCommittedAt,
            terminalStatus: commit.responseStatus,
          });
        });
      }
      recordSandboxOperation({
        sandboxType: "runner",
        actionType: "run_terminal_transition_committed",
        durationMs: 0,
        success: true,
        runId: input.body.runId,
        timestamp: terminalCommittedAtIso,
      });
      logAgentRunCompletionOutcome(input, commit);
    } else if (
      commit.run.status === "completed" ||
      commit.run.status === "failed"
    ) {
      L.debug("Processed duplicate completion for terminal run", {
        runId: input.body.runId,
        status: commit.run.status,
        activeInputFinalized: commit.finalization.finalized,
      });
    }
    const redriveTerminalChatCallback =
      !commit.transitioned &&
      (commit.run.status === "completed" || commit.run.status === "failed") &&
      (await undeliveredChatCallbackIdForRun(db, input.body.runId)) !==
        undefined;
    signal.throwIfAborted();
    return completionResponse(
      input.body.runId,
      commit,
      redriveTerminalChatCallback,
    );
  },
);
