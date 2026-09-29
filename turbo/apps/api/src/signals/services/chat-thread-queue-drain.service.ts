import { command, type Command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishActiveInputToRunnerGroup } from "../external/realtime";
import { settle, tapError } from "../utils";
import { orgHasRunCapacity } from "./agent-run-create.service";
import { dispatchFailedRunCallbacks$ } from "./agent-run-callback.service";
import {
  consumeChatQueueHead$,
  rejectUnconsumedChatQueueHead$,
} from "./chat-queue-consume.service";
import type { ChatQueuePickResult } from "./chat-queue-wait-reason";
import type { Tx } from "../../lib/db-types";
import {
  listPendingChatInputs,
  loadChatQueueHead,
} from "./chat-event-queue.service";
import {
  chatThreadHasActiveRun,
  claimQueuedChatThread,
  deleteQueuedChatThread,
  listPickableQueuedChatThreads,
  listQueuedChatThreadOrgIds,
  markChatThreadQueued,
  releaseQueuedChatThreadClaim,
  type QueuedChatThreadCursor,
} from "./queued-chat-thread.service";

const L = logger("ChatThreadQueue");

export type EnqueueChatInputStep = "transaction" | "callback" | "queue_upsert";

export interface EnqueueChatInput {
  readonly chatThreadId: string;
  readonly orgId: string;
  /**
   * Write the run-less `input.prompt` / `input.automation` event (and, for a
   * new thread, its minimal `chat_threads` row) in the enqueue transaction.
   * Returns the event id, or null when an idempotent retry appended nothing.
   * Entry-specific context rows are written by the entry in this transaction.
   */
  readonly appendInput: (tx: Tx) => Promise<string | null>;
  /** The producer's own write that commits with the input, when it has one. */
  readonly persistSourceTransition?: (tx: Tx, eventId: string) => Promise<void>;
  /** Optional, fail-open observation for the workflow producer; no other ingress opts in. */
  readonly measureStep?: <T>(
    step: EnqueueChatInputStep,
    operation: () => Promise<T>,
  ) => Promise<T>;
}

async function measureEnqueueStep<T>(
  input: EnqueueChatInput,
  step: EnqueueChatInputStep,
  operation: () => Promise<T>,
): Promise<T> {
  return input.measureStep
    ? await input.measureStep(step, operation)
    : await operation();
}

/**
 * The single enqueue for every chat input: web, CLI and MCP sends,
 * integrations, and every workflow trigger. One transaction appends the
 * run-less input and upserts the thread's `queued_chat_threads` row, clearing
 * any lease so a picker that read the queue as empty cannot delete the row.
 * The entry captures the input's model at enqueue; the pick resolves that
 * decision's route and performs credit admission. Enqueue adds no explicit
 * row lock.
 */
export async function enqueueChatInput(
  db: Db,
  input: EnqueueChatInput,
): Promise<string | null> {
  return await measureEnqueueStep(input, "transaction", async () => {
    return await db.transaction(async (tx) => {
      return await measureEnqueueStep(input, "callback", async () => {
        const eventId = await input.appendInput(tx);
        if (eventId === null) {
          return null;
        }
        await input.persistSourceTransition?.(tx, eventId);
        await measureEnqueueStep(input, "queue_upsert", async () => {
          await markChatThreadQueued(tx, {
            chatThreadId: input.chatThreadId,
            orgId: input.orgId,
          });
        });
        return eventId;
      });
    });
  });
}

/**
 * Tell the thread's running run, if any, that it has a pending input to
 * steer, through its runner group. The runner also reads pending input at
 * startup and after its Ably subscription reconnects.
 */
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

/** Defensive bound on one thread pick's rounds; not a retry. */
const MAX_PICK_ROUNDS = 1024;

/** What one thread pick did, reported by its last round. */
export interface ChatQueuePick extends ChatQueuePickResult {
  readonly orgId: string | null;
}

/**
 * Pick one queued thread, round by round:
 *
 * 1. take the 60-second lease; no row or a held lease ends the pick;
 * 2. a busy thread or a full organization releases the lease and ends it;
 * 3. read the strict-FIFO head; an empty queue deletes the row and ends it;
 * 4. consume the head into a run, or reject it as `input.rejected`; only a
 *    thread that actually became busy preserves an unconsumed head;
 * 5. after a launch, keep the row (clearing the lease) when more input waits,
 *    else delete it; after a consumption without a run, release the lease and
 *    start the next round when more input waits, else delete the row.
 *
 * Deleting and releasing are conditioned on this pick's claim id, which every
 * enqueue clears, so a concurrent enqueue always keeps the row.
 */
export const pickQueuedChatThread$ = command(
  async (
    { set },
    input: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<ChatQueuePick> => {
    const db = set(writeDb$);
    let last: ChatQueuePick = { reason: "thread-busy", orgId: null };
    for (let round = 0; round < MAX_PICK_ROUNDS; round++) {
      const claim = await claimQueuedChatThread(db, input.chatThreadId);
      signal.throwIfAborted();
      if (!claim) {
        return last;
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
      const head = await loadChatQueueHead(db, claim.chatThreadId);
      signal.throwIfAborted();
      if (!head) {
        await deleteQueuedChatThread(db, claim);
        signal.throwIfAborted();
        return last;
      }
      const consumption = await settle(
        set(
          consumeChatQueueHead$,
          {
            chatThreadId: claim.chatThreadId,
            orgId: claim.orgId,
            head,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks$,
          },
          signal,
        ),
        signal,
      );
      if (!consumption.ok) {
        L.error("Failed to consume queued chat input", {
          chatThreadId: claim.chatThreadId,
          eventId: head.id,
          error: consumption.error,
        });
      }
      const consumed = consumption.ok
        ? consumption.value
        : { kind: "passed" as const };
      let next = await loadChatQueueHead(db, claim.chatThreadId);
      signal.throwIfAborted();
      if (consumed.kind === "passed" && next?.id === head.id) {
        if (await chatThreadHasActiveRun(db, claim.chatThreadId)) {
          // Only an actual active run may leave the head for a later pick.
          await releaseQueuedChatThreadClaim(db, claim);
          signal.throwIfAborted();
          return {
            reason: "thread-busy",
            orgId: claim.orgId,
            eventId: head.id,
          };
        }
        await set(
          rejectUnconsumedChatQueueHead$,
          {
            chatThreadId: claim.chatThreadId,
            orgId: claim.orgId,
            eventId: head.id,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks$,
          },
          signal,
        );
        next = await loadChatQueueHead(db, claim.chatThreadId);
        signal.throwIfAborted();
      }
      last =
        consumed.kind === "launched"
          ? {
              reason: "launched",
              orgId: claim.orgId,
              eventId: head.id,
              runId: consumed.runId,
            }
          : { reason: "rejected", orgId: claim.orgId, eventId: head.id };
      if (!next) {
        await deleteQueuedChatThread(db, claim);
        signal.throwIfAborted();
        return last;
      }
      await releaseQueuedChatThreadClaim(db, claim);
      signal.throwIfAborted();
      if (consumed.kind === "launched") {
        // The next input waits for this run's end, which picks the org.
        return last;
      }
    }
    L.warn("Chat thread pick reached its round limit", {
      chatThreadId: input.chatThreadId,
      rounds: MAX_PICK_ROUNDS,
    });
    return last;
  },
);

/**
 * After an enqueue commits: pick the thread once and notify its running run
 * in two independent background tasks. `afterPick` (an integration's wait
 * notice) runs after the pick; `touch` (a direct send's best-effort sidebar
 * touch) and then `publish` (the UI realtime event) run last, also when the
 * pick fails. No entry awaits the pick.
 */
export function createEnqueuedChatThreadPickScheduler<AfterPickInput>(
  afterPick$: Command<
    Promise<void>,
    [AfterPickInput, ChatQueuePick, AbortSignal]
  >,
) {
  return command(
    (
      { set },
      input: {
        readonly chatThreadId: string;
        readonly afterPick?: AfterPickInput;
        readonly touch?: () => Promise<void>;
        readonly publish?: () => Promise<void>;
      },
    ): void => {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        (async () => {
          const picked = await settle(
            (async () => {
              const pick = await set(
                pickQueuedChatThread$,
                { chatThreadId: input.chatThreadId },
                backgroundSignal,
              );
              if (input.afterPick !== undefined) {
                await set(afterPick$, input.afterPick, pick, backgroundSignal);
              }
            })(),
          );
          await input.touch?.();
          await input.publish?.();
          if (!picked.ok) {
            L.error("Failed to pick enqueued chat thread", {
              chatThreadId: input.chatThreadId,
              error: picked.error,
            });
          }
        })(),
      );
      waitUntil(
        notifyRunningChatRunOfPendingInput(set(writeDb$), input.chatThreadId),
      );
    },
  );
}

const runEnqueuedChatThreadAfterPick$ = command(
  (
    _context,
    afterPick: (pick: ChatQueuePick, signal: AbortSignal) => Promise<void>,
    pick: ChatQueuePick,
    signal: AbortSignal,
  ) => {
    return afterPick(pick, signal);
  },
);

export const scheduleEnqueuedChatThreadPick$ =
  createEnqueuedChatThreadPickScheduler(runEnqueuedChatThreadAfterPick$);

/** Keyset page size for passes over queued threads and organizations. */
const PICK_PAGE_SIZE = 100;

/**
 * Pick the organization's queued threads oldest first by a (queued_at,
 * chat_thread_id) keyset until the organization is full or no pickable
 * thread remains. Slot release, the cron, and a concurrency-limit change all
 * use this; no thread has priority. A failed thread pick is logged and does
 * not stop the pass.
 */
export const pickOrgQueuedChatThreads$ = command(
  async (
    { set },
    input: { readonly orgId: string },
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
          set(pickQueuedChatThread$, { chatThreadId }, signal),
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

/**
 * Cron pass: org-pick every organization that has a queued row, without a
 * bound, until the table is exhausted or the request ends.
 */
export const pickAllQueuedOrgs$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    let launched = 0;
    let after: string | undefined;
    while (true) {
      const orgIds = await listQueuedChatThreadOrgIds(db, {
        limit: PICK_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      signal.throwIfAborted();
      for (const orgId of orgIds) {
        const picked = await settle(
          set(pickOrgQueuedChatThreads$, { orgId }, signal),
          signal,
        );
        if (!picked.ok) {
          L.error("Failed to pick queued organization", {
            orgId,
            error: picked.error,
          });
          continue;
        }
        launched += picked.value;
      }
      const last = orgIds.at(-1);
      if (orgIds.length < PICK_PAGE_SIZE || last === undefined) {
        return launched;
      }
      after = last;
    }
  },
);
