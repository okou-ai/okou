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
import { and, desc, eq, gte, sql } from "drizzle-orm";

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

const CHAT_SEARCH_CANDIDATE_LIMIT = 500;

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

/**
 * Take up to 500 scoped keyword hits without ordering them, then sort only
 * those candidates by time. This intentionally does not find the newest hits
 * across all history; missing or deleted threads are not backfilled.
 */
async function chatSearchVisibleMatches(
  db: ReadonlyDb,
  args: {
    readonly userId: string;
    readonly orgId: string;
    readonly keyword: string;
    readonly agentId?: string;
    readonly since?: Date;
  },
): Promise<ChatSearchMatchRow[]> {
  const tsquery = chatSearchBigramTsquery(args.keyword);
  if (tsquery === null) {
    return [];
  }

  const keywordCandidates = db
    .select({
      chatThreadId: chatEventSearchMessages.chatThreadId,
      seqId: chatEventSearchMessages.seqId,
      createdAt: chatEventSearchMessages.createdAt,
    })
    .from(chatEventSearchMessages)
    .where(
      and(
        eq(chatEventSearchMessages.userId, args.userId),
        eq(chatEventSearchMessages.orgId, args.orgId),
        args.agentId
          ? eq(chatEventSearchMessages.agentId, args.agentId)
          : undefined,
        args.since
          ? gte(chatEventSearchMessages.createdAt, args.since)
          : undefined,
        sql`${chatEventSearchMessages.tsv} @@ to_tsquery('simple', ${tsquery})`,
      ),
    )
    // The inner LIMIT is a semantic boundary: ORDER BY applies only to its
    // candidates. It does not bound the work done by the GIN index or force a
    // particular physical index plan.
    .limit(CHAT_SEARCH_CANDIDATE_LIMIT)
    .as("chat_search_keyword_candidates");

  const newestCandidates = db
    .select({
      chatThreadId: keywordCandidates.chatThreadId,
      seqId: keywordCandidates.seqId,
      createdAt: keywordCandidates.createdAt,
    })
    .from(keywordCandidates)
    .orderBy(
      desc(keywordCandidates.createdAt),
      desc(keywordCandidates.chatThreadId),
      desc(keywordCandidates.seqId),
    )
    .limit(CHAT_SEARCH_RESULT_LIMIT)
    .as("chat_search_newest_candidates");

  const matches = await db
    .select({
      chatThreadId: chatEventSearchMessages.chatThreadId,
      seqId: chatEventSearchMessages.seqId,
      runId: chatEventSearchMessages.runId,
      role: chatEventSearchMessages.role,
      createdAt: chatEventSearchMessages.createdAt,
      text: chatEventSearchMessages.text,
      existingChatThreadId: chatThreads.id,
      agentName: agents.name,
    })
    .from(newestCandidates)
    .innerJoin(
      chatEventSearchMessages,
      and(
        eq(chatEventSearchMessages.chatThreadId, newestCandidates.chatThreadId),
        eq(chatEventSearchMessages.seqId, newestCandidates.seqId),
      ),
    )
    .leftJoin(chatThreads, eq(chatThreads.id, newestCandidates.chatThreadId))
    .leftJoin(agents, eq(agents.id, chatEventSearchMessages.agentId))
    .orderBy(
      desc(newestCandidates.createdAt),
      desc(newestCandidates.chatThreadId),
      desc(newestCandidates.seqId),
    );

  return matches.flatMap((candidate): ChatSearchMatchRow[] => {
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
    const matches = await chatSearchVisibleMatches(db, {
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
