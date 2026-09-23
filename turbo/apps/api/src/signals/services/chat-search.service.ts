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
 * Selects up to 25 newest matches from the entire scoped projection. Parent
 * existence and the agent's current name are resolved after the match limit.
 */
async function chatSearchMatchBatch(
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

  // The result limit applies after keyword matching across the whole scope.
  const matches = db
    .select({
      ...searchMessageColumns,
      agentId: chatEventSearchMessages.agentId,
    })
    .from(chatEventSearchMessages)
    .where(
      and(
        scopeCondition,
        sql`${chatEventSearchMessages.tsv} @@ to_tsquery('simple', ${tsquery})`,
      ),
    )
    .orderBy(
      sql`${desc(chatEventSearchMessages.createdAt)} NULLS LAST`,
      desc(chatEventSearchMessages.chatThreadId),
      desc(chatEventSearchMessages.seqId),
    )
    .limit(CHAT_SEARCH_RESULT_LIMIT)
    .as("chat_search_matches");

  return await db
    .select({
      chatThreadId: matches.chatThreadId,
      seqId: matches.seqId,
      runId: matches.runId,
      role: matches.role,
      createdAt: matches.createdAt,
      text: matches.text,
      existingChatThreadId: chatThreads.id,
      agentName: agents.name,
    })
    .from(matches)
    .leftJoin(chatThreads, eq(matches.chatThreadId, chatThreads.id))
    .leftJoin(agents, eq(matches.agentId, agents.id))
    .orderBy(
      desc(matches.createdAt),
      desc(matches.chatThreadId),
      desc(matches.seqId),
    );
}

/**
 * Discards matches whose source thread has already been deleted, without
 * searching for replacements beyond the first 25 matches.
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
  const candidates = await chatSearchMatchBatch(db, args);
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
