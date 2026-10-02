import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
} from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import { publishActiveInputToRunnerGroup } from "../external/realtime";
import { safeSync, settle, tapError } from "../utils";
import type { PrefetchedAgentBootstrap } from "./agent-bootstrap.service";
import type { PrefetchedModelBootstrap } from "./model-bootstrap.service";
import { listPendingChatInputs } from "./chat-event-queue.service";
import {
  chatInputEnqueueCommits$,
  type ChatInputEnqueueCommit,
} from "./chat-input-enqueue-observation";
import type { ChatQueuePickResult } from "./chat-queue-wait-reason";
import { createPickObjects } from "./pick-chat-run.service";
import {
  listQueuedChatThreadOrgIds,
  markChatThreadQueued,
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
  /** Captures a local receipt; observation failure cannot change a committed input. */
  readonly onCommitted?: (receipt: ChatInputEnqueueCommit) => void;
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
 * run-less input and upserts the thread's `queued_chat_threads` row, advancing
 * its `queuedAt` without touching a live lease; a lease holder whose
 * empty-queue delete misses that change releases and schedules one new pick.
 * The entry captures the input's model at enqueue; the pick resolves that
 * decision's route and performs credit admission. Enqueue adds no explicit
 * row lock.
 */
export async function enqueueChatInput(
  db: Db,
  input: EnqueueChatInput,
): Promise<string | null> {
  return await measureEnqueueStep(input, "transaction", async () => {
    const eventId = await db.transaction(async (tx) => {
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
    const committedAt = now();
    if (eventId !== null) {
      safeSync(() => {
        input.onCommitted?.({ eventId, committedAt });
      });
    }
    return eventId;
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

/**
 * User-facing observation of one enqueued input for integrations, taken after
 * that enqueue's pick has finished.
 */
export interface ChatQueuePick extends ChatQueuePickResult {
  readonly orgId: string;
}

/**
 * The integration wait reason for one enqueued input, read after that
 * enqueue's pick has finished and never from the pick's return value, since
 * another picker may hold the thread lease (design §5.2):
 * - a later chat_events row revoking the input means it was already handled
 *   (a run claimed it, it was rejected, or the user recalled it);
 * - otherwise a thread in `active_agent_runs` is running, and the input steers
 *   into that run;
 * - otherwise the input waits for an organization slot.
 * Rare cases, such as an earlier queued input rejected ahead of this one, may
 * report `org-full` for an idle thread; that gap is accepted.
 */
export const enqueuedChatQueueWaitReason$ = command(
  async (
    { get },
    input: {
      readonly orgId: string;
      readonly chatThreadId: string;
      readonly eventId: string;
    },
    signal: AbortSignal,
  ): Promise<ChatQueuePick> => {
    const database = get(db$);
    const [revoker] = await database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, input.chatThreadId),
          eq(chatEvents.revokesEventId, input.eventId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (revoker) {
      return { orgId: input.orgId, reason: "handled" };
    }
    const [active] = await database
      .select({ runId: activeAgentRuns.runId })
      .from(activeAgentRuns)
      .where(eq(activeAgentRuns.chatThreadId, input.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    return { orgId: input.orgId, reason: active ? "running" : "org-full" };
  },
);

/** Pick once. The entry owns background scheduling and all post-pick work. */
export const pickEnqueuedChatThread$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly chatThreadId: string;
      readonly enqueueCommit?: ChatInputEnqueueCommit;
      readonly prefetchedBootstrap?: PrefetchedAgentBootstrap;
      readonly prefetchedModels?: PrefetchedModelBootstrap;
    },
    signal: AbortSignal,
  ) => {
    const receipt = input.enqueueCommit;
    if (receipt) {
      set(chatInputEnqueueCommits$, (previous) => {
        return new Map(previous).set(receipt.eventId, receipt.committedAt);
      });
    }
    const { pick$ } = createPickObjects(
      input.orgId,
      input.chatThreadId,
      input.prefetchedBootstrap,
      input.prefetchedModels,
    );
    return await set(pick$, signal);
  },
);

/** Keyset page size for passes over queued threads and organizations. */
const PICK_PAGE_SIZE = 100;

/**
 * A finite organization pass handles at most the queued-thread count captured
 * at entry. One factory owns the keyset cursor and skips active/leased work;
 * each candidate is visited once, even when it has no input, loses its claim,
 * or rejects its head. A `none` pick is not a signal that the organization is
 * empty; the pass stops early only when a pick found the organization full.
 * Remaining input and new work are handled by the next enqueue, slot release,
 * or cron pass. Unexpected errors propagate to the caller's error boundary.
 */
export const pickOrgQueuedChatThreads$ = command(
  async (
    { set },
    input: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const database = set(writeDb$);
    const [snapshot] = await database
      .select({ count: count() })
      .from(queuedChatThreads)
      .where(
        and(
          eq(queuedChatThreads.orgId, input.orgId),
          or(
            isNull(queuedChatThreads.claimExpiresAt),
            lte(queuedChatThreads.claimExpiresAt, nowDate()),
          ),
          notExists(
            database
              .select({ runId: activeAgentRuns.runId })
              .from(activeAgentRuns)
              .where(
                eq(
                  activeAgentRuns.chatThreadId,
                  queuedChatThreads.chatThreadId,
                ),
              ),
          ),
        ),
      );
    signal.throwIfAborted();
    if (!snapshot) {
      throw new Error("Queued chat thread count returned no row");
    }
    const { pick$ } = createPickObjects(input.orgId);
    let launched = 0;
    for (let visited = 0; visited < snapshot.count; visited++) {
      const picked = await set(pick$, signal);
      signal.throwIfAborted();
      if (picked.kind === "org-full") {
        return launched;
      }
      if (picked.kind === "launched") {
        launched += 1;
      }
    }
    return launched;
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
