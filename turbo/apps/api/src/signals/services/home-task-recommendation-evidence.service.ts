import { createHash } from "node:crypto";

import { chatEventCompatibilityRole } from "@okouai/api-contracts/contracts/chat-events";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, desc, eq, inArray } from "drizzle-orm";

import { stripMarkdown } from "../../lib/strip-markdown";
import type { Db } from "../external/db";
import {
  canonicalChatEventUserMessage,
  canonicalChatEventVisibleContent,
} from "./canonical-chat-event-read.service";
import { visibleChatEventCondition } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import { chatThreadOrganizationCondition } from "./chat-thread-organization.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./chat-user-message.service";
import {
  collectHomeTaskGmailEvidence,
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
  /** Local-only resolution for an accepted `threadRef`. Never sent upstream. */
  readonly threadIdByRef: ReadonlyMap<string, string>;
  /** Digest of provider-visible evidence plus its local destination identity. */
  readonly digest: string;
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

async function recentThreads(
  db: Pick<Db, "select">,
  args: HomeTaskEvidenceScope,
) {
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
        chatThreadOrganizationCondition(db, args.orgId),
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.id))
    .limit(THREAD_LIMIT);
}

/**
 * Recent visible user requests and assistant answers for the selected threads.
 * Control, hidden/revoked and thinking events never enter recommendation input.
 */
async function recentMessages(
  db: Pick<Db, "select">,
  threadIds: readonly string[],
): Promise<Map<string, HomeTaskEvidenceMessage[]>> {
  const rows = await db
    .select({
      chatThreadId: chatEvents.chatThreadId,
      eventType: chatEvents.eventType,
      content: canonicalChatEventVisibleContent(),
      userMessage: canonicalChatEventUserMessage(),
    })
    .from(chatEvents)
    .where(
      and(
        inArray(chatEvents.chatThreadId, threadIds),
        chatEventTypeIn(["input.prompt", "output.message"]),
        visibleChatEventCondition(db),
      ),
    )
    // `seqId` is only monotonic inside one thread. Ordering a cross-thread
    // query by it would let an old, long conversation crowd out a newer
    // one whose sequence happens to be short.
    .orderBy(desc(chatEvents.createdAt), desc(chatEvents.id))
    .limit(MESSAGE_LIMIT);

  const byThread = new Map<string, HomeTaskEvidenceMessage[]>();
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
      role: chatEventCompatibilityRole(row.eventType),
      text: excerpt(raw, MESSAGE_EXCERPT_CHARS),
    });
    byThread.set(row.chatThreadId, existing);
  }
  return byThread;
}

export async function collectHomeTaskEvidence(
  db: Db,
  args: HomeTaskEvidenceScope,
  signal: AbortSignal,
): Promise<HomeTaskEvidence> {
  const [threadRows, gmail] = await Promise.all([
    recentThreads(db, args),
    collectHomeTaskGmailEvidence(db, args, signal),
  ]);
  signal.throwIfAborted();
  const messages =
    threadRows.length === 0
      ? new Map<string, HomeTaskEvidenceMessage[]>()
      : await recentMessages(
          db,
          threadRows.map((row) => {
            return row.id;
          }),
        );
  signal.throwIfAborted();

  const threadIdByRef = new Map<string, string>();
  const threads = threadRows.map((row, index): HomeTaskEvidenceThread => {
    const ref = `t${(index + 1).toString()}`;
    threadIdByRef.set(ref, row.id);
    return {
      ref,
      title:
        row.title === null ? null : excerpt(row.title, TITLE_EXCERPT_CHARS),
      lastActivityAt: row.lastMessageAt.toISOString(),
      messages: messages.get(row.id) ?? [],
    };
  });
  const providerEvidence = { threads, gmail };
  const destinationIdentity = threads.map((thread) => {
    return { ref: thread.ref, threadId: threadIdByRef.get(thread.ref) };
  });
  return {
    ...providerEvidence,
    threadIdByRef,
    digest: createHash("sha256")
      .update(JSON.stringify({ providerEvidence, destinationIdentity }), "utf8")
      .digest("hex"),
  };
}

export function isHomeTaskEvidenceEmpty(evidence: HomeTaskEvidence): boolean {
  return (
    evidence.gmail.length === 0 &&
    evidence.threads.every((thread) => {
      return thread.messages.length === 0;
    })
  );
}
