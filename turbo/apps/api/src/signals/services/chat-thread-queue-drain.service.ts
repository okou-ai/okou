import { command } from "ccstate";
import { CANCELLATION_RECOVERY_STALE_AFTER_MS } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
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
import { launchQueuedAutomationEvent$ } from "./workflow-chat-event-queue.service";
import type { RunFailure } from "./workflow-automation-launch.service";
import type { ChatQueuePickResult } from "./chat-queue-wait-reason";
import type { Tx } from "../../lib/db-types";
import { expiredCancellationRecoveryThreads } from "./chat-active-run.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  listPendingChatInputs,
  loadChatQueueHead,
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
  /** Dispatch timing an automation trigger collects for its own launch. */
  readonly automationTiming?: ApiDispatchTimingCollector;
  /** The caller's own input, whose outcome the pick reports when reached. */
  readonly eventId?: string;
}

export interface EnqueueChatInput extends DrainChatThreadQueueInput {
  /**
   * Append the run-less `input.prompt` / `input.automation` event and return
   * its id, or null when an idempotent retry appended nothing. Receives the
   * transaction when `persistSourceTransition` is present.
   */
  readonly appendInput: (db: Db | Tx) => Promise<string | null>;
  readonly persistSourceTransition?: (tx: Tx, eventId: string) => Promise<void>;
}

export interface EnqueuedChatInput {
  /** The appended input, or null when nothing new was appended. */
  readonly eventId: string | null;
  readonly pick: ChatQueuePick;
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
  const pendingInput = await listPendingChatInputs(db, {
    chatThreadId,
    eventTypes: ["input.prompt"],
    budgetForRunId: run.id,
  });
  if (pendingInput.length === 0) {
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

/** Bounds the heads one pick consumes without launching a run. */
const MAX_PICK_ATTEMPTS = 5;

/**
 * What one pick did. `rejection` carries the automation failure that
 * consumed the head, for triggers that report it synchronously.
 */
export interface ChatQueuePick extends ChatQueuePickResult {
  readonly orgId: string | null;
  readonly rejection?: RunFailure;
}

type HeadLaunch =
  | { readonly kind: "launched"; readonly runId: string }
  | { readonly kind: "org-full" }
  | { readonly kind: "thread-busy" }
  | { readonly kind: "rejected"; readonly rejection?: RunFailure };

/**
 * Launch one queue head. This is the only branch in the launch path: the
 * head's type selects how launch params are built (a prompt's thread and
 * integration context, or an automation's context with Official Workflow
 * reconciliation). Both claim the head the same way, by a replacement that
 * carries the run id and revokes the head.
 */
const launchQueueHead$ = command(
  async (
    { set },
    input: QueueLaunchInput & {
      readonly orgId: string;
      readonly apiStartTime: number;
      readonly head: { readonly id: string; readonly eventType: string };
    },
    signal: AbortSignal,
  ): Promise<HeadLaunch> => {
    if (input.head.eventType === "input.prompt") {
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
        return outcome;
      }
      if (outcome.kind === "org-full") {
        return { kind: "org-full" };
      }
      if (outcome.kind === "consumed") {
        return { kind: "rejected" };
      }
      // Another picker or run took the head or the thread first.
      return { kind: "thread-busy" };
    }
    const launched = await set(
      launchQueuedAutomationEvent$,
      {
        chatThreadId: input.chatThreadId,
        orgId: input.orgId,
        eventId: input.head.id,
        apiStartTime: input.apiStartTime,
        dispatchFailedCallbacks: input.dispatchFailedCallbacks,
        ...(input.automationTiming ? { timing: input.automationTiming } : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (launched.kind === "launched") {
      return launched;
    }
    if (launched.kind === "org-full") {
      return { kind: "org-full" };
    }
    if (launched.kind === "lost") {
      return { kind: "thread-busy" };
    }
    return { kind: "rejected", rejection: launched.failure };
  },
);

/**
 * Pick one queued thread: take its lease, confirm the thread is idle and the
 * organization has a free slot by a lock-free coarse count (a soft cap),
 * then launch the strict-FIFO head. Heads consumed as `input.rejected` are
 * skipped up to a small bound. The row is removed only after its queue is
 * found empty; any other end releases the lease, and a picker that stops
 * mid-launch leaves the lease to expire.
 */
export const pickQueuedChatThread$ = command(
  async (
    { set },
    input: QueueLaunchInput,
    signal: AbortSignal,
  ): Promise<ChatQueuePick> => {
    const db = set(writeDb$);
    const claim = await claimQueuedChatThread(db, input.chatThreadId);
    signal.throwIfAborted();
    if (!claim) {
      // Another picker holds the lease, or the row is already gone.
      return { reason: "thread-busy", orgId: null };
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
      return { reason: unavailable, orgId: claim.orgId };
    }
    const apiStartTime = input.apiStartTime ?? now();
    // Report the enqueuer's own input when this pick reached it, else the
    // last head's outcome.
    let reported: ChatQueuePick | null = null;
    const report = (picked: ChatQueuePick): ChatQueuePick => {
      const keepOwn =
        input.eventId !== undefined && reported?.eventId === input.eventId;
      if (!keepOwn) {
        reported = picked;
      }
      return picked;
    };
    for (let attempt = 0; attempt < MAX_PICK_ATTEMPTS; attempt++) {
      const head = await loadChatQueueHead(db, claim.chatThreadId);
      signal.throwIfAborted();
      if (!head) {
        await deleteQueuedChatThread(db, claim);
        signal.throwIfAborted();
        return reported ?? { reason: "thread-busy", orgId: claim.orgId };
      }
      const launch = await set(
        launchQueueHead$,
        { ...input, orgId: claim.orgId, apiStartTime, head },
        signal,
      );
      const picked = report({
        reason: launch.kind,
        orgId: claim.orgId,
        eventId: head.id,
        ...(launch.kind === "launched" ? { runId: launch.runId } : {}),
        ...(launch.kind === "rejected" && launch.rejection
          ? { rejection: launch.rejection }
          : {}),
      });
      if (launch.kind === "rejected") {
        continue;
      }
      if (
        launch.kind === "launched" &&
        !(await loadChatQueueHead(db, claim.chatThreadId))
      ) {
        await deleteQueuedChatThread(db, claim);
      } else {
        await releaseQueuedChatThreadClaim(db, claim);
      }
      signal.throwIfAborted();
      return picked;
    }
    await releaseQueuedChatThreadClaim(db, claim);
    signal.throwIfAborted();
    return reported ?? { reason: "thread-busy", orgId: claim.orgId };
  },
);

/**
 * The single enqueue entry for every chat input: web sends, integrations,
 * MCP, and every automation trigger. It (1) upserts the thread's
 * queued_chat_threads row, clearing any lease; (2) appends the run-less
 * input; (3) picks the thread once. Writing the row first means a crash in
 * between leaves only an empty row, which the next pick deletes, and never
 * input without a row. When the thread has a running run, a pending prompt is
 * announced to it for steering instead of picking.
 *
 * `persistSourceTransition` is the one caller-owned write that may share the
 * input's transaction; enqueue does not look into it.
 */
export const enqueueChatInput$ = command(
  async (
    { set },
    input: EnqueueChatInput,
    signal: AbortSignal,
  ): Promise<EnqueuedChatInput> => {
    const db = set(writeDb$);
    await markChatThreadQueued(db, {
      chatThreadId: input.chatThreadId,
      orgId: input.orgId,
    });
    signal.throwIfAborted();
    const { persistSourceTransition, appendInput } = input;
    const eventId = persistSourceTransition
      ? await db.transaction(async (tx) => {
          const appended = await appendInput(tx);
          if (appended !== null) {
            await persistSourceTransition(tx, appended);
          }
          return appended;
        })
      : await appendInput(db);
    signal.throwIfAborted();
    const pick = await set(
      pickEnqueuedChatThread$,
      { ...input, ...(eventId === null ? {} : { eventId }) },
      signal,
    );
    return { eventId, pick };
  },
);

/**
 * Re-enter the queue for input that is already persisted (a retried send,
 * input returned to the queue by a run's end, or a recovery), without
 * appending anything.
 */
export const pickEnqueuedChatThread$ = command(
  async (
    { set },
    input: DrainChatThreadQueueInput,
    signal: AbortSignal,
  ): Promise<ChatQueuePick> => {
    const db = set(writeDb$);
    await markChatThreadQueued(db, {
      chatThreadId: input.chatThreadId,
      orgId: input.orgId,
    });
    signal.throwIfAborted();
    const steering = await notifyRunningChatRunOfPendingInput(
      db,
      input.chatThreadId,
    );
    signal.throwIfAborted();
    if (steering) {
      return { reason: "steering", orgId: input.orgId };
    }
    return await set(pickQueuedChatThread$, input, signal);
  },
);

/** Keyset page size for passes over queued threads. */
const PICK_PAGE_SIZE = 100;

/**
 * Pick the organization's oldest pickable threads by a (queued_at,
 * chat_thread_id) keyset, paging past busy threads, until the organization
 * is full or its rows are exhausted. A run release starts at most one run; a
 * capacity increase keeps picking. A failed pick is logged and never stops
 * the pass.
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
    let launched = 0;
    let after: QueuedChatThreadCursor | undefined;
    while (true) {
      const rows = await listPickableQueuedChatThreads(db, {
        orgId: input.orgId,
        limit: PICK_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      signal.throwIfAborted();
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
        if (picked.value.reason === "org-full") {
          return launched;
        }
        if (picked.value.reason === "launched") {
          launched += 1;
          if (!input.untilFull) {
            return launched;
          }
        }
      }
      const last = rows.at(-1);
      if (rows.length < PICK_PAGE_SIZE || last === undefined) {
        return launched;
      }
      after = last;
    }
  },
);

/** The chat thread whose queue a run's end wakes, or null for other runs. */
export async function queueThreadIdForRun(
  db: Db,
  runId: string,
): Promise<string | null> {
  const [run] = await db
    .select({ chatThreadId: agentRuns.chatThreadId })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return run?.chatThreadId ?? null;
}

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
    if (picked.value.reason === "launched") {
      L.warn("Cron launched queued chat input that no trigger picked", {
        chatThreadId: input.chatThreadId,
        orgId: picked.value.orgId,
        runId: picked.value.runId,
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
          pickEnqueuedChatThread$,
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
        limit: PICK_PAGE_SIZE,
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
      if (rows.length < PICK_PAGE_SIZE || last === undefined) {
        return recoveryThreads.length + picked;
      }
      after = last;
    }
  },
);
