/**
 * Launch admission bookkeeping: thread session snapshot validation/binding and
 * admission attempt outcome timing. Moved verbatim out of the legacy execution
 * graph.
 */
import {
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import { eq } from "drizzle-orm";
import { agentSessions } from "@okouai/db/schema/agent-session";
import type { AdmissionAttemptOutcome } from "./api-dispatch-admission-timing.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  AtomicLaunchCommitResult,
  CreateRunErrorResult,
  DbTransaction,
  LaunchRunIdentity,
  PendingRunArguments,
  PendingThreadSessionResolution,
  PreparedRunnerLaunch,
  ThreadSessionBindingWrite,
  ValidatedThreadSessionSnapshot,
  threadSessionBindingAction,
  timingDimensionsForCreateArgs,
  validatedThreadSessionTransaction,
} from "./execution-launch-persistence.service";

type AtomicLaunchCommitAttempt =
  | AtomicLaunchCommitResult
  | CreateRunErrorResult;

export interface AtomicLaunchCommitCompletion {
  readonly result: AtomicLaunchCommitAttempt;
  readonly transactionReturnedAt: number;
}

export async function persistThreadSessionBinding(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly identity: LaunchRunIdentity;
    readonly resolution: PendingThreadSessionResolution | undefined;
    readonly timing: ApiDispatchTimingCollector;
    readonly validatedThreadSession?: ValidatedThreadSessionSnapshot;
  },
): Promise<ThreadSessionBindingWrite> {
  const chatThreadId = args.chatThreadId;
  const validatedThreadSession =
    args.validatedThreadSession?.[validatedThreadSessionTransaction] === tx &&
    args.validatedThreadSession.chatThreadId === chatThreadId
      ? args.validatedThreadSession
      : undefined;
  const thread = validatedThreadSession
    ? { agentSessionId: validatedThreadSession.agentSessionId }
    : await args.timing.measure(
        "api_dispatch_load_thread_session_binding",
        "nested",
        async () => {
          const [loaded] = await tx
            .select({ agentSessionId: chatThreads.agentSessionId })
            .from(chatThreads)
            .where(eq(chatThreads.id, chatThreadId))
            .limit(1);
          return loaded;
        },
      );
  if (!thread) {
    throw new Error("Chat thread not found while persisting session binding");
  }

  const action = threadSessionBindingAction({
    identity: args.identity,
    previousAgentSessionId: thread.agentSessionId,
    resolution: args.resolution,
  });
  const [updated] = await args.timing.measure(
    "api_dispatch_update_thread_session_binding",
    "nested",
    async () => {
      return await tx
        .update(chatThreads)
        .set({
          agentSessionId: args.identity.sessionId,
          agentSessionRunId: args.identity.runId,
        })
        .where(eq(chatThreads.id, chatThreadId))
        .returning({ id: chatThreads.id });
    },
  );
  if (!updated) {
    throw new Error("Failed to persist chat thread session binding");
  }

  return {
    chatThreadId: updated.id,
    agentSessionId: args.identity.sessionId,
    agentSessionRunId: args.identity.runId,
    action,
  };
}

export async function validateThreadSessionSnapshot(
  tx: DbTransaction,
  args: {
    readonly createArgs: PendingRunArguments;
    readonly identity: LaunchRunIdentity;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<ValidatedThreadSessionSnapshot | undefined> {
  const resolution = args.createArgs.threadSessionResolution;
  const chatThreadId = args.createArgs.chatThreadId;
  if (!chatThreadId) {
    return undefined;
  }

  const [thread] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_thread",
    "nested",
    async () => {
      return await tx
        .select({
          agentSessionId: chatThreads.agentSessionId,
          agentSessionRunId: chatThreads.agentSessionRunId,
        })
        .from(chatThreads)
        .where(eq(chatThreads.id, chatThreadId))
        .limit(1);
    },
  );
  if (!thread) {
    throw new Error("Chat thread not found while validating session snapshot");
  }
  // No thread row lock: the binding update compares this run id, and the
  // final active-run insert is the per-thread lock.
  if (!resolution) {
    return undefined;
  }
  if (
    thread.agentSessionId !== resolution.expected.agentSessionId ||
    thread.agentSessionRunId !== resolution.expected.agentSessionRunId
  ) {
    throw new Error("Chat thread session changed during run preparation");
  }

  const expectedSessionId = resolution.expected.sessionId;
  if (expectedSessionId === null) {
    return Object.freeze({
      kind: "validated-thread-session-snapshot",
      chatThreadId,
      agentSessionId: thread.agentSessionId,
      agentSessionRunId: thread.agentSessionRunId,
      [validatedThreadSessionTransaction]: tx,
    });
  }
  const [session] = await args.timing.measure(
    "api_dispatch_validate_thread_session_snapshot_session",
    "nested",
    async () => {
      return await tx
        .select({ conversationId: agentSessions.conversationId })
        .from(agentSessions)
        .where(eq(agentSessions.id, expectedSessionId))
        .for("update")
        .limit(1);
    },
  );
  if (
    !session ||
    session.conversationId !== resolution.expected.conversationId
  ) {
    throw new Error("Chat thread session changed during run preparation");
  }
  return Object.freeze({
    kind: "validated-thread-session-snapshot",
    chatThreadId,
    agentSessionId: thread.agentSessionId,
    agentSessionRunId: thread.agentSessionRunId,
    [validatedThreadSessionTransaction]: tx,
  });
}

export function admissionAttemptOutcome(
  result: AtomicLaunchCommitResult | CreateRunErrorResult,
): AdmissionAttemptOutcome {
  if ("kind" in result) {
    if (result.kind === "pending") {
      return "pending";
    }
    if (result.kind === "queue-first-claim-lost") {
      return "queue_first_claim_lost";
    }
  }
  return "rejected";
}

export function flushQueueFirstClaimLostTiming(args: {
  readonly createArgs: PendingRunArguments;
  readonly identity: LaunchRunIdentity;
  readonly launch: PreparedRunnerLaunch;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}): void {
  args.phaseTiming.appendTo(args.timing);
  args.timing.flush({
    runId: args.identity.runId,
    runnerGroup: args.launch.runnerJobPayload.runnerGroup,
    profile: args.launch.runnerJobPayload.profile,
    dispatchPath: "direct",
    dimensions: {
      ...timingDimensionsForCreateArgs(args.createArgs),
      queue_first_launch_outcome: "claim_lost",
    },
    ...(args.createArgs.body.triggerSource
      ? { triggerSource: args.createArgs.body.triggerSource }
      : {}),
  });
}
