import { command } from "ccstate";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import { publishActiveInputToRunnerGroup } from "../external/realtime";
import { settle, tapError } from "../utils";
import { orgHasRunCapacity } from "./agent-run-create.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { consumeChatQueueHead$ } from "./chat-queue-consume.service";
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

export interface EnqueueChatInput {
  readonly chatThreadId: string;
  readonly orgId: string;
  /**
   * Write the run-less `input.prompt` / `input.automation` event (and, for a
   * new thread, its minimal `chat_threads` row) in the enqueue transaction.
   * Returns the event id, or null when an idempotent retry appended nothing.
   * Entry-specific context rows are written by the entry before enqueue.
   */
  readonly appendInput: (tx: Tx) => Promise<string | null>;
  /** The producer's own write that commits with the input, when it has one. */
  readonly persistSourceTransition?: (tx: Tx, eventId: string) => Promise<void>;
}

/**
 * The single enqueue for every chat input: web, CLI and MCP sends,
 * integrations, and every workflow trigger. One transaction appends the
 * run-less input and upserts the thread's `queued_chat_threads` row, clearing
 * any lease so a picker that read the queue as empty cannot delete the row.
 * Enqueue takes no lock and computes no admission; the pick does.
 */
export async function enqueueChatInput(
  db: Db,
  input: EnqueueChatInput,
): Promise<string | null> {
  return await db.transaction(async (tx) => {
    const eventId = await input.appendInput(tx);
    if (eventId !== null && input.persistSourceTransition) {
      await input.persistSourceTransition(tx, eventId);
    }
    await markChatThreadQueued(tx, {
      chatThreadId: input.chatThreadId,
      orgId: input.orgId,
    });
    return eventId;
  });
}

/**
 * Tell the thread's running run, if any, that it has a pending prompt to
 * steer, through its runner group. The runner's own poll covers a lost push.
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
 *    429 leaves it waiting (the lease is released and the pick ends);
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
      const consumed = await set(
        consumeChatQueueHead$,
        {
          chatThreadId: claim.chatThreadId,
          orgId: claim.orgId,
          head,
          dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        },
        signal,
      );
      signal.throwIfAborted();
      if (consumed.kind === "waiting") {
        await releaseQueuedChatThreadClaim(db, claim);
        signal.throwIfAborted();
        return { reason: "org-full", orgId: claim.orgId, eventId: head.id };
      }
      const next = await loadChatQueueHead(db, claim.chatThreadId);
      signal.throwIfAborted();
      if (consumed.kind === "passed" && next?.id === head.id) {
        // The head was neither launched nor consumed because the thread
        // became busy between the check and the launch; the run's end picks
        // the organization again.
        await releaseQueuedChatThreadClaim(db, claim);
        signal.throwIfAborted();
        return { reason: "thread-busy", orgId: claim.orgId, eventId: head.id };
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
 * notice) runs after the pick; `publish` (the UI realtime event) runs last
 * and also when the pick fails. No entry awaits the pick.
 */
export const scheduleEnqueuedChatThreadPick$ = command(
  (
    { set },
    input: {
      readonly chatThreadId: string;
      readonly afterPick?: (
        pick: ChatQueuePick,
        signal: AbortSignal,
      ) => Promise<void>;
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
            await input.afterPick?.(pick, backgroundSignal);
          })(),
        );
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
 * bound, until the table is exhausted or the request ends. `orgIds` narrows
 * the pass for fixture-scoped runs.
 */
export const pickAllQueuedOrgs$ = command(
  async (
    { set },
    input: { readonly orgIds?: readonly string[] },
    signal: AbortSignal,
  ): Promise<number> => {
    const db = set(writeDb$);
    let launched = 0;
    let after: string | undefined;
    while (true) {
      const orgIds =
        input.orgIds ??
        (await listQueuedChatThreadOrgIds(db, {
          limit: PICK_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        }));
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
      if (
        input.orgIds !== undefined ||
        orgIds.length < PICK_PAGE_SIZE ||
        last === undefined
      ) {
        return launched;
      }
      after = last;
    }
  },
);
