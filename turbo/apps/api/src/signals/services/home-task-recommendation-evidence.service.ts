import { createHash } from "node:crypto";

import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { Db } from "../external/db";
import { stripMarkdown } from "../../lib/strip-markdown";
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

type SelectDb = Pick<Db, "select">;

/** How many recent threads describe "what this member has been doing". */
const THREAD_LIMIT = 40;
/**
 * Messages read across all of those threads combined.
 *
 * The evidence is a digest of intent, not a transcript, so the ceiling is on
 * the whole collection rather than per thread: one very active thread is
 * allowed to contribute more lines than a dormant one, and the query cost
 * stays a single bounded scan either way.
 */
const MESSAGE_LIMIT = 120;
/** Messages any one thread may contribute, so one busy thread cannot crowd out the rest. */
const MESSAGE_PER_THREAD_LIMIT = 3;
const MESSAGE_EXCERPT_CHARS = 280;
const TITLE_EXCERPT_CHARS = 120;

export interface HomeTaskEvidenceThread {
  /** Opaque within one generation; the model never receives a thread id. */
  readonly ref: string;
  readonly title: string | null;
  readonly lastActivityAt: string;
  readonly messages: readonly string[];
}

export interface HomeTaskEvidenceConnector {
  readonly slug: string;
  /** A connector that needs reconnecting can still describe intent, not capability. */
  readonly connected: boolean;
}

export interface HomeTaskEvidence {
  readonly threads: readonly HomeTaskEvidenceThread[];
  readonly connectors: readonly HomeTaskEvidenceConnector[];
  /**
   * Digest of exactly what the model would be shown. Equal digests mean the
   * evidence has not moved, which is what lets a refresh reuse the cached
   * cards instead of paying for an identical generation.
   */
  readonly digest: string;
}

function excerpt(value: string, cap: number): string {
  const text = stripMarkdown(value).replace(/\s+/g, " ").trim();
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

async function recentThreads(db: SelectDb, args: HomeTaskEvidenceScope) {
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
        chatThreadOrganizationCondition(db, args.orgId),
      ),
    )
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(THREAD_LIMIT);
}

/**
 * The member's own recent prompts, newest first, across the selected threads.
 *
 * Only `input.prompt` travels. What the member asked for is the intent signal
 * this feature ranks; assistant output would mostly restate it at far greater
 * length, and reading it here would put generated text back into a generation
 * input for no added evidence.
 */
async function recentPrompts(
  db: SelectDb,
  threadIds: readonly string[],
): Promise<Map<string, string[]>> {
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
        chatEventTypeIn(["input.prompt"]),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(desc(chatEvents.seqId))
    .limit(MESSAGE_LIMIT);

  const byThread = new Map<string, string[]>();
  for (const row of rows) {
    const userMessage = requiredUserMessageForEvent(
      row.eventType,
      row.userMessage,
    );
    const text = userMessage
      ? projectUserMessage(userMessage).agentPrompt
      : row.content;
    if (text === null || text.trim().length === 0) {
      continue;
    }
    const existing = byThread.get(row.chatThreadId) ?? [];
    if (existing.length >= MESSAGE_PER_THREAD_LIMIT) {
      continue;
    }
    existing.push(excerpt(text, MESSAGE_EXCERPT_CHARS));
    byThread.set(row.chatThreadId, existing);
  }
  return byThread;
}

/**
 * The connector inventory this member actually owns in this workspace.
 *
 * Inventory only: the slug and whether the connection is currently usable. No
 * provider content is read here, so a recommendation can say "you have Gmail
 * connected" and must never claim to know what is in the mailbox.
 */
async function connectorInventory(
  db: SelectDb,
  args: HomeTaskEvidenceScope,
): Promise<HomeTaskEvidenceConnector[]> {
  const rows = await db
    .select({
      slug: connectors.connectorSlug,
      needsReconnect: connectors.needsReconnect,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        isNotNull(connectors.connectorSlug),
      ),
    );

  // One member may hold several accounts on the same connector. The inventory
  // describes capability, so the slug appears once and counts as connected
  // when any of its accounts still is.
  const bySlug = new Map<string, boolean>();
  for (const row of rows) {
    if (row.slug === null) {
      continue;
    }
    bySlug.set(
      row.slug,
      (bySlug.get(row.slug) ?? false) || !row.needsReconnect,
    );
  }
  return [...bySlug.entries()]
    .map(([slug, connected]) => {
      return { slug, connected };
    })
    .sort((left, right) => {
      return left.slug.localeCompare(right.slug);
    });
}

export interface HomeTaskEvidenceScope {
  readonly userId: string;
  readonly orgId: string;
}

export async function collectHomeTaskEvidence(
  db: SelectDb,
  args: HomeTaskEvidenceScope,
  signal: AbortSignal,
): Promise<HomeTaskEvidence> {
  const threadRows = await recentThreads(db, args);
  signal.throwIfAborted();
  const prompts =
    threadRows.length === 0
      ? new Map<string, string[]>()
      : await recentPrompts(
          db,
          threadRows.map((row) => {
            return row.id;
          }),
        );
  signal.throwIfAborted();
  const connectorRows = await connectorInventory(db, args);
  signal.throwIfAborted();

  const threads = threadRows.map((row, index): HomeTaskEvidenceThread => {
    return {
      ref: `t${(index + 1).toString()}`,
      title:
        row.title === null ? null : excerpt(row.title, TITLE_EXCERPT_CHARS),
      lastActivityAt: row.lastMessageAt.toISOString(),
      messages: prompts.get(row.id) ?? [],
    };
  });
  const evidence = { threads, connectors: connectorRows };
  return {
    ...evidence,
    digest: createHash("sha256")
      .update(JSON.stringify(evidence), "utf8")
      .digest("hex"),
  };
}

/** True when there is not enough of the member's own activity to rank anything. */
export function isHomeTaskEvidenceEmpty(evidence: HomeTaskEvidence): boolean {
  return (
    evidence.connectors.length === 0 &&
    evidence.threads.every((thread) => {
      return thread.messages.length === 0;
    })
  );
}
