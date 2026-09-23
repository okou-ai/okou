import { computed, type Computed } from "ccstate";
import {
  CHAT_SEARCH_RESULT_LIMIT,
  type ChatSearchMessage,
  type ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { agents } from "@okouai/db/schema/agent";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { and, desc, eq, gte, sql, type SQL } from "drizzle-orm";

import {
  chatSearchBigramTsquery,
  chatSearchMatchRanges,
} from "../../lib/chat-search-bigram";
import { db$, type ReadonlyDb } from "../external/db";

type ChatSearchMessageRow = {
  readonly chatThreadId: string;
  readonly seqId: number;
  readonly runId: string | null;
  readonly role: "user" | "assistant";
  readonly createdAt: Date;
  readonly text: string;
};

type ChatSearchMatchRow = ChatSearchMessageRow & {
  readonly agentName: string;
};

type ChatSearchCandidateRow = ChatSearchMessageRow & {
  readonly existingChatThreadId: string | null;
  readonly agentName: string | null;
};

const searchMessageColumns = {
  chatThreadId: chatEventSearchMessages.chatThreadId,
  seqId: chatEventSearchMessages.seqId,
  runId: chatEventSearchMessages.runId,
  role: chatEventSearchMessages.role,
  createdAt: chatEventSearchMessages.createdAt,
  text: chatEventSearchMessages.text,
} as const;

const RECENT_SEARCH_CANDIDATE_MULTIPLIER = 16;

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  return {
    chatThreadId: row.chatThreadId,
    role: row.role,
    content:
      row.role === "assistant" &&
      !(row.runId === null && isRetiredGoalArchiveText(row.text))
        ? visiblePiMemoryCitationText(row.text)
        : row.text,
    createdAt: row.createdAt.toISOString(),
    seqId: row.seqId,
    runId: row.runId,
  };
}

function chatSearchRecentMatches(
  db: ReadonlyDb,
  args: {
    readonly scopeCondition: SQL | undefined;
    readonly tsquery: string;
    readonly limit: number;
  },
) {
  // Search only the newest bounded window, even when it contains fewer than
  // 25 keyword matches. The result count does not trigger a history scan.
  const recentMessages = db
    .select({
      ...searchMessageColumns,
      agentId: chatEventSearchMessages.agentId,
      tsv: chatEventSearchMessages.tsv,
    })
    .from(chatEventSearchMessages)
    .where(args.scopeCondition)
    .orderBy(
      sql`${desc(chatEventSearchMessages.createdAt)} NULLS LAST`,
      desc(chatEventSearchMessages.chatThreadId),
      desc(chatEventSearchMessages.seqId),
    )
    .limit(args.limit * RECENT_SEARCH_CANDIDATE_MULTIPLIER)
    .as("chat_search_recent_messages");
  return db.$with("chat_search_recent_matches").as(
    db
      .select({
        chatThreadId: recentMessages.chatThreadId,
        seqId: recentMessages.seqId,
        runId: recentMessages.runId,
        role: recentMessages.role,
        createdAt: recentMessages.createdAt,
        text: recentMessages.text,
        agentId: recentMessages.agentId,
      })
      .from(recentMessages)
      .where(
        sql`${recentMessages.tsv} @@ to_tsquery('simple', ${args.tsquery})`,
      )
      .orderBy(
        sql`${desc(recentMessages.createdAt)} NULLS LAST`,
        desc(recentMessages.chatThreadId),
        desc(recentMessages.seqId),
      )
      .limit(args.limit),
  );
}

/**
 * Selects matches from one bounded window in the durable projection. Parent
 * existence and the agent's current name are resolved after the match limit.
 */
async function chatSearchRecentMatchBatch(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
  },
): Promise<ChatSearchCandidateRow[]> {
  const tsquery = chatSearchBigramTsquery(args.keyword);
  if (tsquery === null) {
    return [];
  }

  const scopeCondition = and(
    eq(chatEventSearchMessages.userId, args.userId),
    eq(chatEventSearchMessages.orgId, args.orgId),
    args.agentId
      ? eq(chatEventSearchMessages.agentId, args.agentId)
      : undefined,
    args.since ? gte(chatEventSearchMessages.createdAt, args.since) : undefined,
  );

  const recentMatches = chatSearchRecentMatches(db, {
    scopeCondition,
    tsquery,
    limit: CHAT_SEARCH_RESULT_LIMIT,
  });

  return await db
    .with(recentMatches)
    .select({
      chatThreadId: recentMatches.chatThreadId,
      seqId: recentMatches.seqId,
      runId: recentMatches.runId,
      role: recentMatches.role,
      createdAt: recentMatches.createdAt,
      text: recentMatches.text,
      existingChatThreadId: chatThreads.id,
      agentName: agents.name,
    })
    .from(recentMatches)
    .leftJoin(chatThreads, eq(recentMatches.chatThreadId, chatThreads.id))
    .leftJoin(agents, eq(recentMatches.agentId, agents.id))
    .orderBy(
      desc(recentMatches.createdAt),
      desc(recentMatches.chatThreadId),
      desc(recentMatches.seqId),
    );
}

/**
 * Discards matches whose source thread has already been deleted, without
 * widening the search window to replace them.
 */
async function chatSearchRecentVisibleMatches(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
  },
): Promise<ChatSearchMatchRow[]> {
  const candidates = await chatSearchRecentMatchBatch(db, args);
  return candidates.flatMap((candidate): ChatSearchMatchRow[] => {
    if (
      candidate.existingChatThreadId === null ||
      candidate.agentName === null
    ) {
      return [];
    }
    return [
      {
        chatThreadId: candidate.chatThreadId,
        seqId: candidate.seqId,
        runId: candidate.runId,
        role: candidate.role,
        createdAt: candidate.createdAt,
        text: candidate.text,
        agentName: candidate.agentName,
      },
    ];
  });
}

export function chatSearch(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly agentId?: string;
  readonly since?: number;
}): Computed<
  Promise<{
    readonly results: readonly ChatSearchResult[];
  }>
> {
  return computed(async (get) => {
    const db = get(db$);
    const sinceDate = args.since ? new Date(args.since) : undefined;
    const matches = await chatSearchRecentVisibleMatches(db, {
      userId: args.userId,
      orgId: args.orgId,
      keyword: args.keyword,
      agentId: args.agentId,
      since: sinceDate,
    });

    const results = matches.map((match): ChatSearchResult => {
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        agentName: match.agentName,
        matchedMessage,
        matchedRanges: chatSearchMatchRanges(
          matchedMessage.content,
          args.keyword,
        ),
      };
    });

    return { results };
  });
}
