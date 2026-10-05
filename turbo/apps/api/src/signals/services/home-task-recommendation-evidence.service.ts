import { createHash } from "node:crypto";

import { chatEventCompatibilityRole } from "@okouai/api-contracts/contracts/chat-events";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, desc, eq, inArray, isNull, not } from "drizzle-orm";

import { stripMarkdown } from "../../lib/strip-markdown";
import { writeDb$ } from "../external/db";
import { command } from "ccstate";
import {
  canonicalChatEventContent,
  canonicalChatEventUserMessage,
} from "./canonical-chat-event-read.service";
import { visibleChatEventPredicate } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { unfinishedActiveChatRunExists } from "./chat-run-state-read.service";
import { chatThreadOrganizationPredicate } from "./chat-thread-organization.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  collectHomeTaskGmailEvidence$,
  type HomeTaskGmailEvidence,
} from "./home-task-recommendation-gmail.service";

/** How many of this Agent's recent threads can contribute evidence. */
const THREAD_LIMIT = 40;
/** Messages read across all selected threads combined. */
const MESSAGE_LIMIT = 160;
/** Recent user/assistant messages any one thread may contribute. */
const MESSAGE_PER_THREAD_LIMIT = 6;
const MESSAGE_EXCERPT_CHARS = 350;
const TITLE_EXCERPT_CHARS = 120;

export interface HomeTaskEvidenceMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface HomeTaskEvidenceThread {
  /** Opaque within one generation; provider inputs never receive a thread id. */
  readonly ref: string;
  readonly title: string | null;
  readonly lastActivityAt: string;
  /** Newest first. */
  readonly messages: readonly HomeTaskEvidenceMessage[];
}

export interface HomeTaskEvidence {
  readonly threads: readonly HomeTaskEvidenceThread[];
  readonly gmail: readonly HomeTaskGmailEvidence[];
  /** Only visible user requests attached to runs that actually completed. */
  readonly completedRequests: readonly {
    readonly threadRef: string;
    readonly text: string;
  }[];
  /** Local-only resolution for an accepted `threadRef`. Never sent upstream. */
  readonly threadIdByRef: ReadonlyMap<string, string>;
  /** Digest of provider-visible evidence plus its local destination identity. */
  readonly digest: string;
}

interface RecentMessage extends HomeTaskEvidenceMessage {
  readonly runId: string | null;
}

export interface HomeTaskEvidenceScope {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
}

function excerpt(value: string, cap: number): string {
  const text = stripMarkdown(value).replace(/\s+/g, " ").trim();
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

const recentThreads$ = command(async ({ set }, args: HomeTaskEvidenceScope) => {
  const db = set(writeDb$);

  return await db
    .select({
      id: chatThreads.id,
      title: chatThreads.title,
      lastMessageAt: chatThreads.lastMessageAt,
    })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, args.agentId),
        chatThreadOrganizationPredicate(args.orgId),
        not(unfinishedActiveChatRunExists({ chatThreadId: chatThreads.id })),
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
    .limit(THREAD_LIMIT);
});

/**
 * The given threads that still hold pending (run-less, unrevoked) queue input,
 * read in two steps scoped to exactly these threads: their run-less input
 * rows, then the revocations of those rows. Input held by an open active
 * delivery belongs to an active run, which already excludes its thread.
 */
export const threadIdsWithPendingInput$ = command(
  async (
    { set },
    threadIds: readonly string[],
  ): Promise<ReadonlySet<string>> => {
    const db = set(writeDb$);

    if (threadIds.length === 0) {
      return new Set();
    }
    const candidates = await db
      .select({ id: chatEvents.id, chatThreadId: chatEvents.chatThreadId })
      .from(chatEvents)
      .where(
        and(
          inArray(chatEvents.chatThreadId, [...threadIds]),
          isNull(chatEvents.runId),
          chatEventTypeIn(["input.prompt", "input.automation"]),
        ),
      );
    const eventIds = candidates.map(({ id }) => {
      return id;
    });
    const revokedRows =
      eventIds.length === 0
        ? []
        : await db
            .select({ eventId: chatEvents.revokesEventId })
            .from(chatEvents)
            .where(inArray(chatEvents.revokesEventId, eventIds));
    const revoked = new Set(
      revokedRows.flatMap(({ eventId }) => {
        return eventId === null ? [] : [eventId];
      }),
    );
    return new Set(
      candidates.flatMap((event) => {
        return revoked.has(event.id) ? [] : [event.chatThreadId];
      }),
    );
  },
);

/**
 * Recent visible user requests and assistant answers for the selected threads.
 * Control, hidden/revoked and thinking events never enter recommendation input.
 */
const recentMessages$ = command(
  async (
    { set },
    threadIds: readonly string[],
  ): Promise<Map<string, RecentMessage[]>> => {
    const db = set(writeDb$);

    const rows = await db
      .select({
        chatThreadId: chatEvents.chatThreadId,
        runId: chatEvents.runId,
        eventType: chatEvents.eventType,
        content: canonicalChatEventContent(),
        userMessage: canonicalChatEventUserMessage(),
      })
      .from(chatEvents)
      .where(
        and(
          inArray(chatEvents.chatThreadId, threadIds),
          chatEventTypeIn(["input.prompt", "output.message"]),
          visibleChatEventPredicate(),
        ),
      )
      // `seqId` is only monotonic inside one thread. Ordering a cross-thread
      // query by it would let an old, long conversation crowd out a newer
      // one whose sequence happens to be short.
      .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
      .limit(MESSAGE_LIMIT);

    const byThread = new Map<string, RecentMessage[]>();
    for (const row of rows) {
      const existing = byThread.get(row.chatThreadId) ?? [];
      if (existing.length >= MESSAGE_PER_THREAD_LIMIT) {
        continue;
      }
      const userMessage = requiredUserMessageForEvent(
        row.eventType,
        row.userMessage,
      );
      const raw = userMessage
        ? projectUserMessage(userMessage).agentPrompt
        : row.content;
      if (raw === null || raw.trim().length === 0) {
        continue;
      }
      existing.push({
        runId: row.runId,
        role: chatEventCompatibilityRole(row.eventType),
        text: excerpt(raw, MESSAGE_EXCERPT_CHARS),
      });
      byThread.set(row.chatThreadId, existing);
    }
    return byThread;
  },
);

export const collectHomeTaskEvidence$ = command(
  async (
    { set },
    args: HomeTaskEvidenceScope,
    signal: AbortSignal,
  ): Promise<HomeTaskEvidence> => {
    const db = set(writeDb$);

    const [recentThreadRows, gmail] = await Promise.all([
      set(recentThreads$, args),
      set(collectHomeTaskGmailEvidence$, args, signal),
    ]);
    signal.throwIfAborted();
    const pendingThreadIds = await set(
      threadIdsWithPendingInput$,
      recentThreadRows.map((row) => {
        return row.id;
      }),
    );
    signal.throwIfAborted();
    const threadRows = recentThreadRows.filter((row) => {
      return !pendingThreadIds.has(row.id);
    });
    const messages =
      threadRows.length === 0
        ? new Map<string, RecentMessage[]>()
        : await set(
            recentMessages$,
            threadRows.map((row) => {
              return row.id;
            }),
          );
    signal.throwIfAborted();

    const runIds = [
      ...new Set(
        [...messages.values()].flatMap((items) => {
          return items.flatMap((item) => {
            return item.runId === null ? [] : [item.runId];
          });
        }),
      ),
    ];
    const completedRuns =
      runIds.length === 0
        ? []
        : await db
            .select({ runId: chatEvents.runId })
            .from(chatEvents)
            .where(
              and(
                inArray(chatEvents.runId, runIds),
                inArray(
                  chatEvents.chatThreadId,
                  threadRows.map((thread) => {
                    return thread.id;
                  }),
                ),
                eq(chatEvents.eventType, "run.completed"),
              ),
            );
    signal.throwIfAborted();
    const completedRunIds = new Set(
      completedRuns.map((run) => {
        return run.runId;
      }),
    );
    const seenCompletedRunIds = new Set<string>();
    const completedRequests: { threadRef: string; text: string }[] = [];

    const threadIdByRef = new Map<string, string>();
    const threads = threadRows.map((row, index): HomeTaskEvidenceThread => {
      const ref = `t${(index + 1).toString()}`;
      threadIdByRef.set(ref, row.id);
      const recent = messages.get(row.id) ?? [];
      for (const message of recent) {
        if (
          message.role === "user" &&
          message.runId !== null &&
          completedRunIds.has(message.runId) &&
          !seenCompletedRunIds.has(message.runId)
        ) {
          seenCompletedRunIds.add(message.runId);
          completedRequests.push({ threadRef: ref, text: message.text });
        }
      }
      return {
        ref,
        title:
          row.title === null ? null : excerpt(row.title, TITLE_EXCERPT_CHARS),
        lastActivityAt: row.lastMessageAt.toISOString(),
        messages: recent.map(({ role, text }) => {
          return { role, text };
        }),
      };
    });
    const providerEvidence = { threads, gmail, completedRequests };
    const destinationIdentity = threads.map((thread) => {
      return { ref: thread.ref, threadId: threadIdByRef.get(thread.ref) };
    });
    return {
      ...providerEvidence,
      threadIdByRef,
      digest: createHash("sha256")
        .update(
          JSON.stringify({ providerEvidence, destinationIdentity }),
          "utf8",
        )
        .digest("hex"),
    };
  },
);

export function isHomeTaskEvidenceEmpty(evidence: HomeTaskEvidence): boolean {
  return (
    evidence.gmail.length === 0 &&
    evidence.threads.every((thread) => {
      return thread.messages.length === 0;
    })
  );
}
