import { command } from "ccstate";
import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import {
  publishActiveInputToRunnerGroup,
  publishChatThreadDetailChangedSafely,
} from "../external/realtime";
import { settle, tapError } from "../utils";
import {
  orgHasRunCapacity,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import {
  drainQueuedUserMessagesForThread$,
  type ChatCallbackPreCreateTimingCollector,
} from "./internal-chat-run-callback.service";
import {
  drainWorkflowQueueForThread$,
  type WorkflowQueueDrainResult,
} from "./workflow-queue-drain.service";
import { expiredCancellationRecoveryThreads } from "./chat-active-run.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  loadChatQueueHead,
  pendingActiveInputCondition,
} from "./chat-event-queue.service";
import {
  chatThreadHasActiveRun,
  claimQueuedChatThread,
  deleteQueuedChatThread,
  listPickableQueuedChatThreads,
  markChatThreadQueued,
  releaseQueuedChatThreadClaim,
  type QueuedChatThreadCursor,
} from "./queued-chat-thread.service";

const DRAIN_SWEEP_LIMIT = 20;
const L = logger("ChatThreadQueueDrain");

interface DrainChatThreadQueueInput {
  readonly apiStartTime?: number;
  readonly chatThreadId: string;
  /** The thread's organization, known to every caller; no thread lookup. */
  readonly orgId: string;
  readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
  readonly automationEventLaunch?: {
    readonly eventId: string;
    readonly apiStartTime: number;
    readonly timing: ApiDispatchTimingCollector;
  };
}

/** Pickers read the organization from the leased row, not from the caller. */
type QueueLaunchInput = Omit<DrainChatThreadQueueInput, "orgId">;

export async function notifyRunningChatRunOfPendingInput(
  db: Db,
  chatThreadId: string,
): Promise<boolean> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      runnerGroup: agentRuns.runnerGroup,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, chatThreadId),
        eq(agentRuns.status, "running"),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (!run) {
    return false;
  }
  const [pendingInput] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, chatThreadId),
        pendingActiveInputCondition(db, run.id),
      ),
    )
    .limit(1);
  if (!pendingInput) {
    return false;
  }
  if (run.runnerGroup) {
    await tapError(
      publishActiveInputToRunnerGroup(run.runnerGroup, run.id),
      (error) => {
        L.warn("Failed to notify runner about active input", {
          chatThreadId,
          runId: run.id,
          error,
        });
      },
    );
  }
  return true;
}

type QueueLaunchStep =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "consumed" | "stopped" | "empty" };

/** Bounds the heads one pick consumes without launching a run. */
const MAX_PICK_ATTEMPTS = 5;

interface QueueHeadLaunch {
  readonly step: Exclude<QueueLaunchStep, { readonly kind: "consumed" }>;
  readonly automationResult: WorkflowQueueDrainResult | null;
}

/**
 * Launch the thread's FIFO queue head through the existing queue-first launch.
 * Heads that are consumed without a run (rejected or unfireable input) are
 * skipped up to a small bound. The launch's active-run insert and the head's
 * unique revoke edge are the only mutual exclusion.
 */
const launchChatThreadQueueHead$ = command(
  async (
    { set },
    input: QueueLaunchInput & { readonly apiStartTime: number },
    signal: AbortSignal,
  ): Promise<QueueHeadLaunch> => {
    const db = set(writeDb$);
    let automationResult: WorkflowQueueDrainResult | null = null;
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      const head = await loadChatQueueHead(db, input.chatThreadId);
      signal.throwIfAborted();
      if (!head) {
        return { step: { kind: "empty" }, automationResult };
      }
      const once = await set(
        launchQueueHeadOnce$,
        { ...input, headEventType: head.eventType },
        signal,
      );
      if (once.automationResult) {
        automationResult = once.automationResult;
      }
      if (once.step.kind !== "consumed") {
        return { step: once.step, automationResult };
      }
    }
    return { step: { kind: "stopped" }, automationResult };
  },
);

function workflowLaunchStep(
  result: WorkflowQueueDrainResult["result"],
): Exclude<QueueLaunchStep, { readonly kind: "empty" }> {
  if (result.kind === "ok") {
    return { kind: "launched", runId: result.runId };
  }
  return { kind: result.kind === "enqueued" ? "stopped" : "consumed" };
}

const launchQueueHeadOnce$ = command(
  async (
    { set },
    input: QueueLaunchInput & {
      readonly apiStartTime: number;
      readonly headEventType: "input.prompt" | "input.automation";
    },
    signal: AbortSignal,
  ): Promise<{
    readonly step: Exclude<QueueLaunchStep, { readonly kind: "empty" }>;
    readonly automationResult: WorkflowQueueDrainResult | null;
  }> => {
    if (input.headEventType === "input.prompt") {
      const outcome = await set(
        drainQueuedUserMessagesForThread$,
        {
          chatThreadId: input.chatThreadId,
          apiStartTime: input.apiStartTime,
          timing: input.timing,
        },
        signal,
      );
      signal.throwIfAborted();
      if (outcome.kind === "launched") {
        return { step: outcome, automationResult: null };
      }
      // "none": the head changed under this picker; read it again.
      return {
        step: { kind: outcome.kind === "stopped" ? "stopped" : "consumed" },
        automationResult: null,
      };
    }
    const workflowResult = await set(
      drainWorkflowQueueForThread$,
      {
        chatThreadId: input.chatThreadId,
        apiStartTime: input.apiStartTime,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        ...(input.automationEventLaunch
          ? { automationEventLaunch: input.automationEventLaunch }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (!workflowResult) {
      return { step: { kind: "consumed" }, automationResult: null };
    }
    return {
      step: workflowLaunchStep(workflowResult.result),
      automationResult: workflowResult,
    };
  },
);

type PickOutcome =
  | { readonly kind: "not-claimed" | "thread-busy" | "org-full" }
  | QueueHeadLaunch["step"];

interface PickResult {
  readonly outcome: PickOutcome;
  readonly orgId: string | null;
  readonly automationResult: WorkflowQueueDrainResult | null;
}

/**
 * Pick one queued thread: take its lease, confirm the thread is idle and the
 * organization has a free slot by a lock-free coarse count, then launch the
 * queue head. The row is removed only after its queue is found empty; any
 * other end releases the lease, and a picker that stops mid-launch leaves the
 * lease to expire.
 */
export const pickQueuedChatThread$ = command(
  async (
    { set },
    input: QueueLaunchInput,
    signal: AbortSignal,
  ): Promise<PickResult> => {
    const db = set(writeDb$);
    const claim = await claimQueuedChatThread(db, input.chatThreadId);
    signal.throwIfAborted();
    if (!claim) {
      return {
        outcome: { kind: "not-claimed" },
        orgId: null,
        automationResult: null,
      };
    }
    const unavailable = (await chatThreadHasActiveRun(db, claim.chatThreadId))
      ? "thread-busy"
      : (await orgHasRunCapacity(db, claim.orgId))
        ? null
        : "org-full";
    signal.throwIfAborted();
    if (unavailable !== null) {
      await releaseQueuedChatThreadClaim(db, claim);
      signal.throwIfAborted();
      return {
        outcome: { kind: unavailable },
        orgId: claim.orgId,
        automationResult: null,
      };
    }
    const launch = await set(
      launchChatThreadQueueHead$,
      { ...input, apiStartTime: input.apiStartTime ?? now() },
      signal,
    );
    if (launch.step.kind === "empty") {
      await deleteQueuedChatThread(db, claim);
    } else if (
      launch.step.kind === "launched" &&
      !(await loadChatQueueHead(db, claim.chatThreadId))
    ) {
      await deleteQueuedChatThread(db, claim);
    } else {
      await releaseQueuedChatThreadClaim(db, claim);
    }
    signal.throwIfAborted();
    return {
      outcome: launch.step,
      orgId: claim.orgId,
      automationResult: launch.automationResult,
    };
  },
);

/**
 * The per-thread scheduler entry for new input: ingress, web sends, workflow
 * events, cancel, resume and recovery converge here after appending input.
 * Every enqueue records the thread as queued first, so queued input always
 * has a row even when a running run takes it as steerable input or the
 * takeover at run end never happens. Then a running run is notified, or the
 * thread is picked once.
 */
export const drainChatThreadQueueForThread$ = command(
  async (
    { set },
    input: DrainChatThreadQueueInput,
    signal: AbortSignal,
  ): Promise<WorkflowQueueDrainResult | null> => {
    const db = set(writeDb$);
    await markChatThreadQueued(db, {
      chatThreadId: input.chatThreadId,
      orgId: input.orgId,
    });
    signal.throwIfAborted();

    const notifiedRunningRun = await notifyRunningChatRunOfPendingInput(
      db,
      input.chatThreadId,
    );
    signal.throwIfAborted();
    if (notifiedRunningRun) {
      return null;
    }

    const picked = await set(pickQueuedChatThread$, input, signal);
    return picked.automationResult;
  },
);

/**
 * A run of this thread just released its active slot, so the thread's next
 * input takes that slot over without the organization pre-check. The queue
 * head is read from `chat_events` directly. Enqueue already recorded the
 * thread's row, so input that cannot start now stays pickable.
 */
export const takeOverChatThreadQueue$ = command(
  async (
    { set },
    input: QueueLaunchInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(
      launchChatThreadQueueHead$,
      { ...input, apiStartTime: input.apiStartTime ?? now() },
      signal,
    );
    signal.throwIfAborted();
  },
);

/** Batch bound for one organization's pass over its queued threads. */
const ORG_PICK_BATCH_LIMIT = 20;

/**
 * Pick the organization's oldest pickable threads, stopping at its capacity.
 * A run release starts at most one run; a capacity increase keeps picking.
 * A failed pick is logged and never stops the pass.
 */
export const pickOrgQueuedChatThreads$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly untilFull: boolean;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    const rows = await listPickableQueuedChatThreads(db, {
      orgId: input.orgId,
      limit: ORG_PICK_BATCH_LIMIT,
    });
    signal.throwIfAborted();
    let launched = 0;
    for (const { chatThreadId } of rows) {
      const picked = await settle(
        set(
          pickQueuedChatThread$,
          {
            chatThreadId,
            dispatchFailedCallbacks: input.dispatchFailedCallbacks,
          },
          signal,
        ),
        signal,
      );
      if (!picked.ok) {
        L.error("Failed to pick queued chat thread", {
          chatThreadId,
          orgId: input.orgId,
          error: picked.error,
        });
        continue;
      }
      if (picked.value.outcome.kind === "org-full") {
        return launched;
      }
      if (picked.value.outcome.kind === "launched") {
        launched += 1;
        if (!input.untilFull) {
          return launched;
        }
      }
    }
    return launched;
  },
);

/** Resolve a terminal run's thread before entering the shared scheduler. */
export const drainChatThreadQueueForRun$ = command(
  async (
    { set },
    input: {
      readonly runId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly apiStartTime: number;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, input.runId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return;
    }
    await set(
      takeOverChatThreadQueue$,
      {
        chatThreadId: run.chatThreadId,
        apiStartTime: input.apiStartTime,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
      },
      signal,
    );
  },
);

/** Keyset page size for the cron pass over queued threads. */
const CRON_PICK_PAGE_SIZE = 100;

/**
 * Pick one thread in the cron pass. Reaching the cron at all means an upstream
 * trigger missed this input, so a launch here is logged as a warning.
 */
const pickQueuedChatThreadFromCron$ = command(
  async (
    { set },
    input: {
      readonly chatThreadId: string;
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const picked = await settle(
      set(pickQueuedChatThread$, input, signal),
      signal,
    );
    if (!picked.ok) {
      L.error("Failed to pick queued chat thread", {
        chatThreadId: input.chatThreadId,
        error: picked.error,
      });
      return;
    }
    if (picked.value.outcome.kind === "launched") {
      L.warn("Cron launched queued chat input that no trigger picked", {
        chatThreadId: input.chatThreadId,
        orgId: picked.value.orgId,
        runId: picked.value.outcome.runId,
      });
    }
  },
);

/**
 * Cron repair: re-enter the scheduler for threads whose cancellation recovery
 * expired, then walk every queued thread whose lease is free or expired by a
 * (queued_at, chat_thread_id) keyset until the table is exhausted or the
 * request ends. Each row goes through the normal pick, which releases its
 * lease when the thread is busy or its organization is full.
 */
export const drainStaleChatThreadQueues$ = command(
  async (
    { set },
    input: {
      readonly dispatchFailedCallbacks: DispatchFailedRunCallbacks;
      readonly chatThreadIds?: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<number> => {
    if (input.chatThreadIds?.length === 0) {
      return 0;
    }
    const db = set(writeDb$);
    const currentTime = nowDate().getTime();
    const recoveryExpiredBefore = new Date(
      currentTime - CANCELLATION_RECOVERY_STALE_AFTER_MS,
    );
    const recoveryThreads = await expiredCancellationRecoveryThreads(db, {
      expiredBefore: recoveryExpiredBefore,
      limit: DRAIN_SWEEP_LIMIT,
      chatThreadIds: input.chatThreadIds,
    });
    signal.throwIfAborted();
    for (const candidate of recoveryThreads) {
      await tapError(
        set(
          drainChatThreadQueueForThread$,
          {
            chatThreadId: candidate.chatThreadId,
            orgId: candidate.orgId,
            dispatchFailedCallbacks: input.dispatchFailedCallbacks,
          },
          signal,
        ),
        (error) => {
          L.error("Failed to drain stale chat thread queue", {
            chatThreadId: candidate.chatThreadId,
            reason: "cancellation-recovery-expired",
            error,
          });
        },
      );
      signal.throwIfAborted();
      await publishChatThreadDetailChangedSafely(
        candidate.userId,
        candidate.chatThreadId,
      );
      signal.throwIfAborted();
    }

    let picked = 0;
    if (input.chatThreadIds !== undefined) {
      for (const chatThreadId of input.chatThreadIds) {
        await set(
          pickQueuedChatThreadFromCron$,
          {
            chatThreadId,
            dispatchFailedCallbacks: input.dispatchFailedCallbacks,
          },
          signal,
        );
        signal.throwIfAborted();
        picked += 1;
      }
      return recoveryThreads.length + picked;
    }
    let after: QueuedChatThreadCursor | undefined;
    while (true) {
      const rows = await listPickableQueuedChatThreads(db, {
        limit: CRON_PICK_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      signal.throwIfAborted();
      for (const row of rows) {
        await set(
          pickQueuedChatThreadFromCron$,
          {
            chatThreadId: row.chatThreadId,
            dispatchFailedCallbacks: input.dispatchFailedCallbacks,
          },
          signal,
        );
        signal.throwIfAborted();
        picked += 1;
      }
      const last = rows.at(-1);
      if (rows.length < CRON_PICK_PAGE_SIZE || last === undefined) {
        return recoveryThreads.length + picked;
      }
      after = last;
    }
  },
);
