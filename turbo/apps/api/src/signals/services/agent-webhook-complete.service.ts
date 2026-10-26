import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import {
  runStatusSchema,
  type RunResult,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { claimedWorkflowAttachments } from "@okouai/db/schema/claimed-workflow-attachment";
import { command, computed } from "ccstate";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { infer as zInfer } from "zod";
import type { Tx } from "../../lib/db-types";
import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import type { SandboxAuth } from "../../types/auth";
import { db$, writeDb$ } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishChatThreadMessageCreatedSafely,
  publishDesktopShellAuthorizationChangedSafely,
} from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { tapError } from "../utils";
import { expireRunTimeBudgetInput$ } from "./active-input-delivery.service";
import { dispatchRunCallbacks$ } from "./agent-run-callback.service";
import {
  logAgentRunFailure,
  type AgentRunFailureLogSnapshot,
} from "./agent-run-failure-log.service";
import {
  persistAgentRunOutputsInTransaction,
  type AgentRunOutputErrorResponse,
  type AgentRunOutputInput,
} from "./agent-run-output.service";
import {
  runSlotReleasePlan,
  transitionAgentRunsToTerminal,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { maybeEmitRunUsageEvent$ } from "./chat-usage-event.service";
import { settleDataRouterRun$ } from "./data-router-billing.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

type WebhookCompleteBody = zInfer<typeof webhookCompleteContract.complete.body>;
type TerminalStatus = "completed" | "failed";

interface CompleteAgentRunInput {
  readonly auth: SandboxAuth;
  readonly body: WebhookCompleteBody;
}

export interface TerminalSideEffectsInput {
  readonly kind: "terminal";
  readonly firstTerminalTransition: boolean;
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

export type CompleteSideEffectsInput =
  | TerminalSideEffectsInput
  | CancellationRecoverySideEffectsInput
  | DeliveryFinalizationSideEffectsInput;

export type DispatchCompleteSideEffectsInput = CompleteSideEffectsInput & {
  readonly skipChatCallback?: true;
};

interface CompletionSuccessResponse {
  readonly status: 200;
  readonly body: {
    readonly success: true;
    readonly status: TerminalStatus;
  };
  /** Slots the completion transaction released. The caller schedules
   * `scheduleReleasedSlotPicks$` for them before any side effect. */
  readonly releasedSlots: readonly ReleasedRunSlot[];
  readonly sideEffects?: CompleteSideEffectsInput;
}

type CompletionResponse =
  CompletionSuccessResponse | AgentRunOutputErrorResponse;

interface RunRecord extends AgentRunFailureLogSnapshot {
  readonly id: string;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly error: string | null;
  readonly orgId: string;
  readonly status: RunStatus;
  readonly userId: string;
  readonly chatThreadId: string | null;
  readonly triggerSource: string | null;
  readonly launchSnapshot: (typeof agentRuns.$inferSelect)["launchSnapshot"];
}

interface PreparedCompletion {
  readonly status: TerminalStatus;
  readonly result?: RunResult;
  readonly error?: string;
  readonly failureReason?: RunFailureReasonToken;
  readonly failureKind?: "missing-outputs" | "reported";
}

/** Whether completion appended active-input events the thread must hear of. */
interface ActiveInputFinalization {
  readonly finalized: boolean;
  readonly chatEventsAppended: boolean;
}

interface CompletionCommit {
  readonly run: RunRecord;
  readonly transitioned: boolean;
  readonly responseStatus: TerminalStatus;
  readonly transitionError?: string;
  readonly transitionFailureKind?: PreparedCompletion["failureKind"];
  readonly transitionFailureReason?: RunFailureReasonToken;
  readonly finalization: ActiveInputFinalization;
}

type CompletionTransactionResult =
  | { readonly kind: "not-found" }
  | { readonly kind: "retry"; readonly chatThreadId: string | null }
  | {
      readonly kind: "response";
      readonly response: AgentRunOutputErrorResponse;
    }
  | { readonly kind: "committed"; readonly commit: CompletionCommit };

type ReleasedCompletionCommit = CompletionCommit & {
  readonly releasedSlots: readonly ReleasedRunSlot[];
};

const L = logger("webhook:complete");

function logAgentRunCompletionOutcome(
  input: CompleteAgentRunInput,
  commit: CompletionCommit,
): void {
  if (commit.responseStatus === "completed") {
    L.debug("Run completed successfully", { runId: input.body.runId });
    return;
  }
  if (commit.transitionFailureKind === "missing-outputs") {
    L.warn("Run failed because completion outputs were not provided", {
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
    run: commit.run,
  });
}

function runOutputInputForCompletion(
  input: CompleteAgentRunInput,
): AgentRunOutputInput | null {
  const completion = input.body.completion;
  if (!completion) {
    return null;
  }
  return {
    auth: input.auth,
    body: {
      ...completion,
      runId: input.body.runId,
    },
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

function createInitialCompletionRun(runId: string, userId: string) {
  return computed(async (get): Promise<RunRecord | null> => {
    const db = get(db$);
    const [run] = await db
      .select({
        id: agentRuns.id,
        error: agentRuns.error,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        userId: agentRuns.userId,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
        chatThreadId: agentRuns.chatThreadId,
        triggerSource: agentRuns.triggerSource,
        launchSnapshot: agentRuns.launchSnapshot,
        modelProvider: agentRuns.modelProvider,
        modelProviderCredentialScope: agentRuns.modelProviderCredentialScope,
        selectedModel: agentRuns.selectedModel,
        modelRuntimeProvider: agentRuns.modelRuntimeProvider,
        modelRuntimeModel: agentRuns.modelRuntimeModel,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, userId)))
      .limit(1);
    if (!run) {
      return null;
    }
    return { ...run, status: runStatusSchema.parse(run.status) };
  });
}

function prepareCompletion(
  input: CompleteAgentRunInput,
  result: RunResult | undefined,
): PreparedCompletion {
  if (input.body.exitCode !== 0) {
    return {
      status: "failed",
      result,
      error: input.body.error?.trim() || "Run failed without error message",
      failureReason: input.body.failureReason,
      failureKind: "reported",
    };
  }
  if (!result) {
    return {
      status: "failed",
      error: "Run completion outputs were not provided",
      failureKind: "missing-outputs",
    };
  }
  return { status: "completed", result };
}

async function lockCompletionRun(
  tx: Tx,
  input: CompleteAgentRunInput,
): Promise<RunRecord | null> {
  const [run] = await tx
    .select({
      id: agentRuns.id,
      error: agentRuns.error,
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      userId: agentRuns.userId,
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
      chatThreadId: agentRuns.chatThreadId,
      triggerSource: agentRuns.triggerSource,
      launchSnapshot: agentRuns.launchSnapshot,
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
  const [updated] = await transitionAgentRunsToTerminal(tx, {
    values: {
      status: prepared.status,
      completedAt,
      ...(prepared.error !== undefined ? { error: prepared.error } : {}),
      failureReason: prepared.failureReason ?? null,
      ...(prepared.result !== undefined ? { result: prepared.result } : {}),
      sandboxId: input.body.sandboxId,
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

function noActiveInputFinalization(): ActiveInputFinalization {
  return {
    finalized: false,
    chatEventsAppended: false,
  };
}

interface CompletionTransitionContext {
  readonly outputInput: AgentRunOutputInput | null;
  readonly expectedChatThreadId: string | null;
}

async function completeActiveAgentRunTransition(
  tx: Tx,
  input: CompleteAgentRunInput,
  run: RunRecord,
  prepared: PreparedCompletion,
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
      finalization: noActiveInputFinalization(),
    },
  };
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
  const { outputInput, expectedChatThreadId } = context;
  // Thread admission is the active run row, which the terminal transition
  // releases; the run row lock serializes completion against other writers.
  const run = await lockCompletionRun(tx, input);
  if (!run) {
    return { kind: "not-found" };
  }
  if (run.chatThreadId !== expectedChatThreadId) {
    return { kind: "retry", chatThreadId: run.chatThreadId };
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
  let runResult: RunResult | undefined;
  if (outputInput) {
    const outputResult = await persistAgentRunOutputsInTransaction(
      tx,
      outputInput,
      signal,
    );
    if (outputResult.status !== 200) {
      return { kind: "response", response: outputResult };
    }
    runResult = outputResult.result;
  }
  const canTransition = run.status === "pending" || run.status === "running";
  const prepared = canTransition ? prepareCompletion(input, runResult) : null;
  // A terminal failure/cancellation may receive its first recovery outputs
  // after the Runner fallback. Preserve that exact evidence on the owning Run.
  if (!canTransition && runResult) {
    await tx
      .update(agentRuns)
      .set({ result: runResult })
      .where(eq(agentRuns.id, run.id));
  }
  signal.throwIfAborted();
  if (input.body.lastEventSequence !== undefined) {
    await persistLastEventSequence(
      tx,
      input.body.runId,
      input.auth.userId,
      input.body.lastEventSequence,
    );
  }
  if (canTransition) {
    if (!prepared) {
      throw new Error("Active agent run completion was not prepared");
    }
    return completeActiveAgentRunTransition(tx, input, run, prepared);
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
      finalization: noActiveInputFinalization(),
    },
  };
}

function completionResponse(
  runId: string,
  commit: ReleasedCompletionCommit,
  redriveTerminalChatCallback: boolean,
): CompletionResponse {
  let sideEffects: CompleteSideEffectsInput | undefined;
  if (commit.transitioned || redriveTerminalChatCallback) {
    sideEffects = {
      kind: "terminal",
      firstTerminalTransition: commit.transitioned,
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
    };
  }
  return {
    status: 200,
    body: { success: true, status: commit.responseStatus },
    releasedSlots: commit.releasedSlots,
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
    releasedSlots: [],
  };
}

const dispatchTerminalCompleteSideEffects$ = command(
  async (
    { set },
    input: TerminalSideEffectsInput & {
      readonly skipChatCallback?: true;
    },
    signal: AbortSignal,
  ): Promise<void> => {
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
    await tapError(
      set(
        dispatchRunCallbacks$,
        {
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

    if (input.firstTerminalTransition) {
      await tapError(
        set(settleDataRouterRun$, input.runId, signal),
        (error) => {
          L.error("Data Router completion billing failed; no retry scheduled", {
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
    // Both the requesting Run's terminal status and the released chat slot
    // participate in shell approval eligibility, even without appended events.
    const shellOwnerId =
      input.kind === "terminal"
        ? input.deliveryNotification?.userId
        : input.chatThreadId !== null
          ? input.userId
          : undefined;
    if (shellOwnerId !== undefined) {
      await publishDesktopShellAuthorizationChangedSafely(shellOwnerId);
      signal.throwIfAborted();
    }
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
      // Undelivered input stays queued; the released slot's org pick or the
      // cron picks it.
      return;
    }
    await set(dispatchTerminalCompleteSideEffects$, input, signal);
  },
);

/**
 * Expire the run's unconsumed time budget steer after the completion commit;
 * the heartbeat-timeout branch never finalizes input, so it is skipped too.
 */
const expireCommittedRunTimeBudget$ = command(
  async (
    { set },
    runId: string,
    commit: ReleasedCompletionCommit,
    signal: AbortSignal,
  ): Promise<ReleasedCompletionCommit> => {
    if (commit.run.chatThreadId === null || commit.run.status === "timeout") {
      return commit;
    }
    const expired = await set(
      expireRunTimeBudgetInput$,
      { runId, chatThreadId: commit.run.chatThreadId },
      signal,
    );
    return expired
      ? {
          ...commit,
          finalization: { finalized: true, chatEventsAppended: true },
        }
      : commit;
  },
);

/**
 * Record telemetry for the committed completion: terminal-transition metrics
 * for the first commit, a debug log for a duplicate terminal completion.
 */
function recordCompletionCommitOutcome(
  input: CompleteAgentRunInput,
  commit: ReleasedCompletionCommit,
): void {
  if (commit.transitioned) {
    const terminalCommittedAt = now();
    const terminalCommittedAtIso = new Date(terminalCommittedAt).toISOString();
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
}

function createCompletionTerminalRedrive(runId: string) {
  return computed(async (get): Promise<string | undefined> => {
    const db = get(db$);
    const [callback] = await db
      .select({ id: agentRunCallbacks.id })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, runId),
          eq(agentRunCallbacks.internalKind, "chat"),
          inArray(agentRunCallbacks.status, ["pending", "failed"]),
        ),
      )
      .limit(1);
    return callback?.id;
  });
}

/** One validated completion request owns this graph and its lazy post-commit read. */
export function createAgentRunCompletion(runId: string, userId: string) {
  const initialRun$ = createInitialCompletionRun(runId, userId);
  const undeliveredTerminalChatCallback$ =
    createCompletionTerminalRedrive(runId);
  const complete$ = command(
    async (
      { get, set },
      input: CompleteAgentRunInput,
      signal: AbortSignal,
    ): Promise<CompletionResponse> => {
      const db = set(writeDb$);
      const initialRun = await get(initialRun$);
      signal.throwIfAborted();
      if (!initialRun) {
        return notFound("Agent run not found");
      }
      if (initialRun.status === "timeout") {
        // Terminal status or silence did not release the claim's packages.
        // This authenticated completion is the Runner's actual acknowledgement.
        await db
          .delete(claimedWorkflowAttachments)
          .where(eq(claimedWorkflowAttachments.runId, runId));
        signal.throwIfAborted();
        return settledRunCompletionResponse(initialRun);
      }
      const outputInput = runOutputInputForCompletion(input);
      let expectedChatThreadId = initialRun.chatThreadId;
      let commit: ReleasedCompletionCommit;
      while (true) {
        // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0050; new non-billing transactions are prohibited.
        const result = await db.transaction(async (tx) => {
          const transition = await completeAgentRunTransition(
            tx,
            input,
            {
              outputInput,
              expectedChatThreadId,
            },
            signal,
          );
          if (transition.kind !== "committed") {
            return transition;
          }
          await tx
            .delete(claimedWorkflowAttachments)
            .where(eq(claimedWorkflowAttachments.runId, input.body.runId));
          // The runner reported completion, so the active row is released
          // whether or not the run ever started. Must stay last in the tx.
          const releaseRunIds = [input.body.runId];
          const releasedSlots = await (async () => {
            const plan = runSlotReleasePlan(releaseRunIds);
            if (plan === null) {
              return [];
            }
            return await tx
              .delete(plan.from)
              .where(plan.where)
              .returning(plan.returning);
          })();
          return {
            kind: transition.kind,
            commit: { ...transition.commit, releasedSlots },
          };
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

      commit = await set(
        expireCommittedRunTimeBudget$,
        input.body.runId,
        commit,
        signal,
      );

      recordCompletionCommitOutcome(input, commit);
      const redriveTerminalChatCallback =
        !commit.transitioned &&
        (commit.run.status === "completed" || commit.run.status === "failed") &&
        (await get(undeliveredTerminalChatCallback$)) !== undefined;
      signal.throwIfAborted();
      return completionResponse(
        input.body.runId,
        commit,
        redriveTerminalChatCallback,
      );
    },
  );
  return { complete$ };
}
