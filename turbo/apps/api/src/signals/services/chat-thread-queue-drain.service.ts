import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import {
  chatEvents,
  chatEventRunlessInputPredicate,
} from "@okouai/db/schema/chat-event";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  isNotNull,
  inArray,
  isNull,
  lte,
  notExists,
  or,
} from "drizzle-orm";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishActiveInputToRunnerGroup } from "../external/realtime";
import { settle, tapError } from "../utils";
import {
  chatInputEnqueueCommits$,
  type ChatInputEnqueueCommit,
} from "./chat-input-enqueue-observation";
import type { ChatQueuePickResult } from "./chat-queue-wait-reason";
import {
  pickChatThread$,
  type OrgPickCursor,
  type PickIteration,
} from "./pick-chat-run.service";
import { listQueuedChatThreadOrgIds$ } from "./queued-chat-thread.service";

const L = logger("ChatThreadQueue");

/**
 * Tell the thread's running run, if any, that it has a pending input to
 * steer, through its runner group. The runner also reads pending input at
 * startup and after its Ably subscription reconnects.
 */
export const notifyRunningChatRunOfPendingInput$ = command(
  async (
    { get },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const database = get(db$);
    const [run] = await database
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
    signal.throwIfAborted();
    if (!run) {
      return false;
    }
    const candidates = await database
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, chatThreadId),
          chatEventRunlessInputPredicate(
            chatEvents.runId,
            chatEvents.eventType,
          ),
          or(
            eq(chatEvents.eventType, "input.prompt"),
            and(
              eq(chatEvents.eventType, "input.budget"),
              eq(chatEvents.contextType, "agent_run"),
              eq(chatEvents.contextId, run.id),
            ),
          ),
        ),
      );
    signal.throwIfAborted();
    if (candidates.length === 0) {
      return false;
    }
    const revokers = await database
      .select({ eventId: chatEvents.revokesEventId })
      .from(chatEvents)
      .where(
        inArray(
          chatEvents.revokesEventId,
          candidates.map((event) => {
            return event.id;
          }),
        ),
      );
    signal.throwIfAborted();
    const revoked = new Set(
      revokers.map((event) => {
        return event.eventId;
      }),
    );
    if (
      candidates.every((event) => {
        return revoked.has(event.id);
      })
    ) {
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
    signal.throwIfAborted();
    return true;
  },
);

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
    },
    signal: AbortSignal,
  ) => {
    const receipt = input.enqueueCommit;
    if (receipt) {
      set(chatInputEnqueueCommits$, (previous) => {
        return new Map(previous).set(receipt.eventId, receipt.committedAt);
      });
    }
    const { result } = await set(pickChatThread$, input, signal);
    return result;
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
    let cursor: OrgPickCursor | null = null;
    let launched = 0;
    for (let visited = 0; visited < snapshot.count; visited++) {
      const { result: picked, cursor: nextCursor }: PickIteration = await set(
        pickChatThread$,
        { orgId: input.orgId, after: cursor },
        signal,
      );
      cursor = nextCursor;
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
    let launched = 0;
    let after: string | undefined;
    while (true) {
      const orgIds = await set(
        listQueuedChatThreadOrgIds$,
        {
          limit: PICK_PAGE_SIZE,
          ...(after === undefined ? {} : { after }),
        },
        signal,
      );
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
