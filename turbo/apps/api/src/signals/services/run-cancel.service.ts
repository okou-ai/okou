import type { RunnerCancellationMode } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { notFound, runNotCancellable } from "../../lib/error";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import {
  publishCancelToRunnerGroup,
  publishChatThreadDetailChangedSafely,
  publishRunQueueChangedForOrgSafely,
} from "../external/realtime";
import { tapError } from "../utils";
import {
  dispatchRunCallbacks$,
  undeliveredChatCallbackIdForRun,
} from "./agent-run-callback.service";
import { cancelLockedRun } from "./agent-run-cancellation-transition.service";
import { scheduleReleasedSlotPicks$ } from "./agent-run-lifecycle.service";
import {
  releaseRunSlots,
  type ReleasedRunSlot,
} from "./agent-run-terminal-transition.service";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { lockCancellationProtection } from "./threadless-run-protection.service";
import { THREADLESS_RUN_PROTECTIONS } from "./threadless-run-protections";

const L = logger("RunCancel");

export interface CancelRunResult {
  readonly apiStartTime: number;
  readonly runId: string;
  readonly previousStatus: string;
  readonly userId: string;
  readonly orgId: string;
  readonly sandboxId: string | null;
  readonly runnerGroup: string | null;
  readonly chatThreadId: string | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly runnerCancellationMode: RunnerCancellationMode | null;
  readonly runnerCancellationChanged: boolean;
  readonly alreadyCancelled: boolean;
}

type NotFoundResponse = ReturnType<typeof notFound>;
type RunNotCancellableResponse = ReturnType<typeof runNotCancellable>;

const ACTIVE_STATUSES = ["pending", "running"] as const;
type ActiveStatus = (typeof ACTIVE_STATUSES)[number];

function isActiveStatus(status: string): status is ActiveStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Cancel a run. Idempotent for already-cancelled runs. Recovery-capable
 * cancellations may redrive only their retry-safe callback and thread-drain
 * side effects. A genuine hard request can upgrade a committed cooperative
 * cancellation and publish the stronger intent; legacy retries otherwise
 * return success without side effects.
 * Returns notFound if the run doesn't exist or is owned by another (org,
 * user) tuple. Returns runNotCancellable for non-cancellable terminal
 * statuses.
 *
 * The transactional shape locks the run row first, classifies the
 * current status under that lock, then updates status and removes
 * derived runner job rows. Side effects use the committed transition.
 */
export const cancelRun$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly runnerCancellationMode: RunnerCancellationMode;
      /** Cleanup retries must not turn an already-cancelled Run into a new hard request. */
      readonly preserveExistingCancellation?: true;
      readonly apiStartTime?: number;
      /** Keep Runs claimed by a registered threadless-run protection out of generic cleanup. */
      readonly protectThreadlessRuns?: true;
    },
    signal: AbortSignal,
  ): Promise<
    NotFoundResponse | RunNotCancellableResponse | CancelRunResult
  > => {
    const apiStartTime = args.apiStartTime ?? now();
    const runId = args.runId.toLowerCase();
    const writeDb = set(writeDb$);

    let releasedSlots: readonly ReleasedRunSlot[] = [];
    const transition = writeDb.transaction(async (tx) => {
      const [run] = await tx
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          userId: agentRuns.userId,
          orgId: agentRuns.orgId,
          sandboxId: agentRuns.sandboxId,
          runnerGroup: agentRuns.runnerGroup,
          runnerCancellationMode: agentRuns.runnerCancellationMode,
          chatThreadId: agentRuns.chatThreadId,
          cancellationRecoveryCompleted:
            agentRuns.cancellationRecoveryCompleted,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, runId),
            eq(agentRuns.userId, args.userId),
            eq(agentRuns.orgId, args.orgId),
          ),
        )
        .for("update");
      if (!run) {
        return notFound(`No such run: '${args.runId}'`);
      }

      if (run.status === "cancelled") {
        const runnerCancellationChanged =
          !args.preserveExistingCancellation &&
          args.runnerCancellationMode === "hard" &&
          run.runnerCancellationMode !== "hard";
        if (runnerCancellationChanged) {
          await tx
            .update(agentRuns)
            .set({ runnerCancellationMode: "hard" })
            .where(eq(agentRuns.id, run.id));
        }
        return {
          apiStartTime,
          runId: run.id,
          previousStatus: run.status,
          userId: run.userId,
          orgId: run.orgId,
          sandboxId: run.sandboxId,
          runnerGroup: run.runnerGroup,
          chatThreadId: run.chatThreadId,
          cancellationRecoveryCompleted: run.cancellationRecoveryCompleted,
          runnerCancellationMode: runnerCancellationChanged
            ? ("hard" as const)
            : run.runnerCancellationMode,
          runnerCancellationChanged,
          alreadyCancelled: true,
        };
      }

      if (!isActiveStatus(run.status)) {
        return runNotCancellable(
          `Run cannot be cancelled: current status is '${run.status}'`,
        );
      }

      if (
        args.protectThreadlessRuns &&
        (await lockCancellationProtection(THREADLESS_RUN_PROTECTIONS, tx, {
          runId: run.id,
          orgId: run.orgId,
          userId: run.userId,
        }))
      ) {
        return runNotCancellable(
          "Run cannot be cancelled while its owner protects it",
        );
      }

      // Persist exactly the effective mode that the Runner notification carries.
      const runnerCancellationMode =
        run.cancellationRecoveryCompleted === null
          ? "hard"
          : args.runnerCancellationMode;
      const releasableRunIds = await cancelLockedRun(tx, {
        runId: run.id,
        status: run.status,
        completedAt: new Date(apiStartTime),
        runnerCancellationMode,
      });
      // A started run keeps its slot until the Runner reports its end.
      releasedSlots = await releaseRunSlots(tx, releasableRunIds);

      return {
        apiStartTime,
        runId: run.id,
        previousStatus: run.status,
        userId: run.userId,
        orgId: run.orgId,
        sandboxId: run.sandboxId,
        runnerGroup: run.runnerGroup,
        chatThreadId: run.chatThreadId,
        cancellationRecoveryCompleted: run.cancellationRecoveryCompleted,
        runnerCancellationMode,
        runnerCancellationChanged: true,
        alreadyCancelled: false,
      };
    });
    const result = await transition;
    signal.throwIfAborted();
    // Only a committed cancellation reaches here: a never-started run's slot
    // goes back to its organization before any other side effect.
    set(scheduleReleasedSlotPicks$, releasedSlots, signal);

    return result;
  },
);

export function shouldDispatchCancelSideEffects(
  result: CancelRunResult,
): boolean {
  return (
    !result.alreadyCancelled ||
    result.cancellationRecoveryCompleted !== null ||
    result.runnerCancellationChanged
  );
}

async function publishCancellationRecoveryEntered(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    result.alreadyCancelled ||
    result.cancellationRecoveryCompleted === null ||
    result.chatThreadId === null
  ) {
    return;
  }
  await publishChatThreadDetailChangedSafely(
    result.userId,
    result.chatThreadId,
  );
  signal.throwIfAborted();
}

async function publishRunnerCancellation(
  result: CancelRunResult,
  signal: AbortSignal,
): Promise<void> {
  if (
    !result.runnerCancellationChanged ||
    (!result.alreadyCancelled && result.previousStatus !== "running") ||
    !result.runnerGroup ||
    result.runnerCancellationMode === null
  ) {
    return;
  }
  await tapError(
    publishCancelToRunnerGroup(
      result.runnerGroup,
      result.runId,
      result.runnerCancellationMode,
    ),
    (error) => {
      L.error("Failed to publish cancel to runner group", {
        runId: result.runId,
        runnerGroup: result.runnerGroup,
        error,
      });
    },
  );
  signal.throwIfAborted();
}

/**
 * Post-cancel side effects:
 *  - Notify the runner group to halt the cancelled run (if it was
 *    running on a runner).
 *  - Reconcile credits via `processOrgUsageEvents$`. The transactional
 *    invariant (events marked processed iff credit deduction succeeds) is
 *    preserved by `processOrgUsageEvents$`.
 *
 * Deferrals (tracked under #12290):
 *  - `triggerAutoRecharge` (Stripe top-up) — sibling follow-up.
 *
 * Fire-and-forget caller: invoke from the route handler via `waitUntil(...)`
 * with a detached background signal after `cancelRun$` commits.
 */
export const dispatchCancelSideEffects$ = command(
  async (
    { set },
    result: CancelRunResult,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!shouldDispatchCancelSideEffects(result)) {
      return;
    }
    const recoveryRedrive = result.alreadyCancelled;
    const db = set(writeDb$);
    await publishCancellationRecoveryEntered(result, signal);
    await publishRunnerCancellation(result, signal);
    await publishRunQueueChangedForOrgSafely(result.orgId);
    signal.throwIfAborted();

    // A hard upgrade must not revive legacy terminal effects that were already suppressed.
    if (
      result.alreadyCancelled &&
      result.cancellationRecoveryCompleted === null
    ) {
      return;
    }

    // An undelivered source callback still owns its post-marker work: delivery
    // registration and chat-run-finished automation admission commit after the
    // lifecycle marker, and its replay is idempotent. An acknowledged callback
    // already committed that work and is never replayed.
    const redriveCallbackId = recoveryRedrive
      ? await undeliveredChatCallbackIdForRun(db, result.runId)
      : undefined;
    signal.throwIfAborted();
    if (!recoveryRedrive || redriveCallbackId !== undefined) {
      await tapError(
        set(
          dispatchRunCallbacks$,
          {
            db,
            runId: result.runId,
            status: "failed",
            error: "Run cancelled",
            ...(redriveCallbackId !== undefined
              ? { redriveChatCallbackId: redriveCallbackId }
              : {}),
          },
          signal,
        ),
        (error) => {
          L.error("Failed to dispatch cancel callbacks", {
            runId: result.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }

    if (recoveryRedrive) {
      return;
    }

    // A fresh cancellation always came from pending or running, so the
    // cancelled run may have accumulated usage events.
    await set(processOrgUsageEvents$, result.orgId, signal);
    signal.throwIfAborted();
  },
);
