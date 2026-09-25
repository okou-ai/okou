import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { isAbortError, settleIncludingAbort } from "../utils";

type RunOutputPhase =
  | "preparation"
  | "chat_event_append"
  | "run_materialization"
  | "memory_citations"
  | "first_assistant_metric";

interface RunOutputFailureFields {
  readonly outputPhase: RunOutputPhase;
  readonly outputPhaseElapsedMs?: number;
  readonly outputAttemptElapsedMs?: number;
}

function boundedElapsed(
  startedAt: number,
  endedAt: number,
): number | undefined {
  const elapsed = endedAt - startedAt;
  // Operation elapsed includes scheduling and execution, not just lock wait.
  return Number.isFinite(elapsed) && elapsed >= 0
    ? Math.min(60_000, Math.round(elapsed))
    : undefined;
}

/** One required-output invocation owns this receipt, never a store or error. */
export class RunOutputDiagnostics {
  private timing:
    | {
        phase: RunOutputPhase;
        phaseStartedAt: number;
        attemptStartedAt: number;
      }
    | undefined;
  private failure:
    | { readonly error: unknown; readonly fields: RunOutputFailureFields }
    | undefined;

  startAttempt(phase: RunOutputPhase): void {
    const startedAt = performance.now();
    this.failure = undefined;
    this.timing = {
      phase,
      phaseStartedAt: startedAt,
      attemptStartedAt: startedAt,
    };
  }

  enter(phase: RunOutputPhase): void {
    if (this.timing) {
      this.timing.phase = phase;
      this.timing.phaseStartedAt = performance.now();
    }
  }

  recordFailure(error: unknown): void {
    if (isAbortError(error) || (this.failure && this.failure.error !== error)) {
      // Rollback can replace a body error. Its provenance is unavailable.
      this.clear();
    } else if (!this.failure && this.timing) {
      const endedAt = performance.now();
      this.failure = {
        error,
        fields: {
          outputPhase: this.timing.phase,
          outputPhaseElapsedMs: boundedElapsed(
            this.timing.phaseStartedAt,
            endedAt,
          ),
          outputAttemptElapsedMs: boundedElapsed(
            this.timing.attemptStartedAt,
            endedAt,
          ),
        },
      };
    }
  }

  takeFailure(error: unknown): RunOutputFailureFields | undefined {
    const fields =
      this.failure && this.failure.error === error
        ? this.failure.fields
        : undefined;
    this.clear();
    return fields;
  }

  clear(): void {
    this.timing = undefined;
    this.failure = undefined;
  }
}

async function observeOutputFailure<T>(
  operation: Promise<T>,
  diagnostics: RunOutputDiagnostics | undefined,
): Promise<T> {
  if (!diagnostics) {
    return await operation;
  }
  // Freeze the original rejection before the transaction driver rolls back.
  // Cancellation is observed only to release diagnostics, then rethrown intact.
  const result = await settleIncludingAbort(operation);
  if (!result.ok) {
    diagnostics.recordFailure(result.error);
    throw result.error;
  }
  return result.value;
}

interface Owner {
  readonly userId: string;
  readonly orgId: string;
}

export class AgentEventRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is missing during output materialization`);
    this.name = "AgentEventRunNotFoundError";
  }
}

class RunContentOwnershipChangedError extends Error {
  constructor(message = "Prepared run content ownership no longer matches") {
    super(message);
  }
}

export interface RunContentOwnership {
  readonly runId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly triggerSource: string | null;
  readonly thread: {
    readonly chatThreadId: string;
    readonly userId: string;
  } | null;
}

/** Preserve timeout disposition before potentially remote history preparation.
 * One primary-key run read, then the thread owner, outside any transaction.
 * The append holds no run lock, so a timeout committed after this read may
 * still admit one batch.
 */
export async function prepareRunOutputOwnership(
  db: Db,
  runId: string,
  diagnostics?: RunOutputDiagnostics,
): Promise<
  | {
      readonly ownership: RunContentOwnership;
      readonly modelProvider: string | null;
    }
  | undefined
> {
  return await observeOutputFailure(
    (async () => {
      const [run] = await db
        .select({
          status: agentRuns.status,
          modelProvider: agentRuns.modelProvider,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          chatThreadId: agentRuns.chatThreadId,
          triggerSource: agentRuns.triggerSource,
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      if (!run) {
        throw new AgentEventRunNotFoundError(runId);
      }
      if (run.status === "timeout") {
        return undefined;
      }
      const [thread] = run.chatThreadId
        ? await db
            .select({
              chatThreadId: chatThreads.id,
              userId: chatThreads.userId,
            })
            .from(chatThreads)
            .where(eq(chatThreads.id, run.chatThreadId))
        : [];
      if (run.chatThreadId && !thread) {
        throw new RunContentOwnershipChangedError();
      }
      return {
        ownership: Object.freeze({
          runId,
          userId: run.userId,
          orgId: run.orgId,
          triggerSource: run.triggerSource,
          thread: thread ? Object.freeze(thread) : null,
        }),
        modelProvider: run.modelProvider,
      };
    })(),
    diagnostics,
  );
}

/** The sandbox token's user and organization must own the prepared run. */
export function assertRunOutputOwner(
  ownership: RunContentOwnership,
  owner: Owner,
): void {
  if (ownership.userId !== owner.userId || ownership.orgId !== owner.orgId) {
    throw new RunContentOwnershipChangedError();
  }
}
