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

export class RunContentOwnershipChangedError extends Error {
  constructor(message = "Prepared run content ownership no longer matches") {
    super(message);
  }
}

async function readOwnership(db: Pick<Db, "select">, runId: string) {
  const [run] = await db
    .select({
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
  const [thread] = run.chatThreadId
    ? await db
        .select({ chatThreadId: chatThreads.id, userId: chatThreads.userId })
        .from(chatThreads)
        .where(eq(chatThreads.id, run.chatThreadId))
    : [];
  if (run.chatThreadId && !thread) {
    throw new RunContentOwnershipChangedError();
  }
  return Object.freeze({
    runId,
    userId: run.userId,
    orgId: run.orgId,
    triggerSource: run.triggerSource,
    thread: thread ? Object.freeze(thread) : null,
  });
}

export type RunContentOwnership = Awaited<ReturnType<typeof readOwnership>>;

/** Preserve timeout disposition before potentially remote history preparation.
 * Bounded primary-key reads outside any transaction; the append holds no run
 * lock, so a timeout committed after this read may still admit one batch.
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
        })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId));
      if (!run) {
        throw new AgentEventRunNotFoundError(runId);
      }
      if (run.status === "timeout") {
        return undefined;
      }
      return {
        ownership: await readOwnership(db, runId),
        modelProvider: run.modelProvider,
      };
    })(),
    diagnostics,
  );
}

function sameOwner(left: Owner, right: Owner): boolean {
  return left.userId === right.userId && left.orgId === right.orgId;
}

interface PreparedRunContentIdentity {
  readonly runId: string;
  readonly runOwner?: Owner;
  readonly destination?: Owner & { readonly threadId: string };
  readonly ownership: RunContentOwnership;
}

function assertPreparedOwnership(
  snapshot: RunContentOwnership,
  args: PreparedRunContentIdentity,
): void {
  if (
    JSON.stringify(snapshot) !== JSON.stringify(args.ownership) ||
    (args.runOwner && !sameOwner(snapshot, args.runOwner)) ||
    (args.destination &&
      (snapshot.thread?.chatThreadId !== args.destination.threadId ||
        snapshot.thread.userId !== args.destination.userId ||
        snapshot.orgId !== args.destination.orgId))
  ) {
    throw new RunContentOwnershipChangedError();
  }
}

/** Pure identity check of a prepared write against its caller's claim. */
export function assertPreparedRunContentIdentity(
  args: PreparedRunContentIdentity,
): void {
  assertPreparedOwnership(args.ownership, args);
}
