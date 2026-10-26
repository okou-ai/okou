import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import {
  runStatusSchema,
  type RunResult,
  type RunStatus,
} from "@okouai/api-contracts/contracts/runs";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command, computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import type { infer as zInfer } from "zod";
import { badRequestMessage, notFound } from "../../lib/error";
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
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";
import { completionPublicationPlan } from "./agent-run-completion-sql";
import { disconnectedPersonalAccountCleanupSql } from "./model-provider-account.service";
import { maybeEmitRunUsageEvent$ } from "./chat-usage-event.service";
import { settleDataRouterRun$ } from "./data-router-billing.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";

type WebhookCompleteBody = zInfer<typeof webhookCompleteContract.complete.body>;
type TerminalStatus = "completed" | "failed";
type AgentRunOutputErrorResponse =
  ReturnType<typeof badRequestMessage> | ReturnType<typeof notFound>;

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

function noActiveInputFinalization(): ActiveInputFinalization {
  return {
    finalized: false,
    chatEventsAppended: false,
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

function completionPublicationRejection(
  decision: string,
): AgentRunOutputErrorResponse {
  if (decision === "not-found") {
    return notFound("Agent run not found");
  }
  if (decision === "mount") {
    return badRequestMessage(
      "Run output does not identify a unique authorized writeback mount",
    );
  }
  if (decision === "native") {
    return badRequestMessage(
      "Native Run output does not match its captured Framework identity",
    );
  }
  if (decision === "type") {
    return badRequestMessage(
      "[PI_H2_TYPE_MISMATCH] Native session type does not match the run launch framework",
    );
  }
  if (decision === "committed") {
    return badRequestMessage(
      "[RUN_OUTPUT_ALREADY_COMMITTED] Final output does not exactly match the committed Run output",
    );
  }
  throw new Error("Run completion output validation failed");
}

function completionPublicationCommit(
  input: CompleteAgentRunInput,
  run: RunRecord,
  output: RunResult | undefined,
  releasedSlots: readonly ReleasedRunSlot[],
): ReleasedCompletionCommit {
  const canTransition = run.status === "pending" || run.status === "running";
  const prepared = canTransition ? prepareCompletion(input, output) : null;
  return {
    run,
    transitioned: canTransition,
    responseStatus:
      prepared?.status ?? (run.status === "completed" ? "completed" : "failed"),
    ...(prepared
      ? {
          transitionError: prepared.error,
          transitionFailureKind: prepared.failureKind,
          transitionFailureReason: prepared.failureReason,
        }
      : persistedTerminalError(run)),
    finalization: noActiveInputFinalization(),
    releasedSlots,
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
        return settledRunCompletionResponse(initialRun);
      }
      let expectedChatThreadId = initialRun.chatThreadId;
      let commit: ReleasedCompletionCommit;
      while (true) {
        const plan = completionPublicationPlan({
          body: input.body,
          userId: input.auth.userId,
          orgId: input.auth.orgId,
          expectedChatThreadId,
          at: nowDate(),
        });
        const result = await (async () => {
          const rows = await db
            .with(...plan.ctes)
            .select(plan.fields)
            .from(plan.from);
          const row = rows[0];
          if (!row) {
            return { kind: "not-found" } as const;
          }
          if (row.decision === "retry") {
            return {
              kind: "retry",
              chatThreadId: row.run.chatThreadId,
            } as const;
          }
          if (row.decision !== "ready") {
            return {
              kind: "response",
              response: completionPublicationRejection(row.decision),
            } as const;
          }
          const releasedSlots =
            row.releasedRunId === null || row.releasedOrgId === null
              ? []
              : [{ runId: row.releasedRunId, orgId: row.releasedOrgId }];
          const committed = completionPublicationCommit(
            input,
            row.run,
            row.outputResult ?? undefined,
            releasedSlots,
          );
          // Credential collection needs a fresh post-publication snapshot.
          // Completed/failed retries repair a previously failed collection too.
          if (
            committed.transitioned ||
            row.run.status === "completed" ||
            row.run.status === "failed"
          ) {
            for (const statement of disconnectedPersonalAccountCleanupSql([
              {
                orgId: row.run.orgId,
                userId: row.run.userId,
                modelProviderId: row.cleanupModelProviderId,
              },
            ])) {
              await db.execute(statement);
            }
          }
          return { kind: "committed", commit: committed } as const;
        })();
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
