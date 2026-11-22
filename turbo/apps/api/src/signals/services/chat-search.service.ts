import { computed, type Computed } from "ccstate";
import {
  CHAT_SEARCH_RESULT_LIMIT,
  type ChatSearchMessage,
  type ChatSearchResult,
} from "@okouai/api-contracts/contracts/chat-threads";
import { projects } from "@okouai/db/schema/project";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, desc, eq, sql } from "drizzle-orm";

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
  readonly projectId: string | null;
  readonly projectName: string | null;
};

const CHAT_SEARCH_CANDIDATE_LIMIT = 500;

function toChatSearchMessage(row: ChatSearchMessageRow): ChatSearchMessage {
  return {
    chatThreadId: row.chatThreadId,
    role: row.role,
    content: row.text,
    createdAt: row.createdAt.toISOString(),
    seqId: row.seqId,
    runId: row.runId,
  };
}

type ChatSearchInput = {
  readonly userId: string;
  readonly orgId: string;
  readonly keyword: string;
  readonly projectId?: string;
  readonly projectMetadata?: boolean;
};

function chatSearchScope(
  args: Pick<ChatSearchInput, "userId" | "orgId" | "projectId">,
) {
  return and(
    eq(chatEventSearchMessages.userId, args.userId),
    eq(chatEventSearchMessages.orgId, args.orgId),
    eq(chatThreads.userId, args.userId),
    eq(chatThreads.orgId, args.orgId),
    eq(chatThreads.hidden, false),
    args.projectId ? eq(chatThreads.projectId, args.projectId) : undefined,
  );
}

async function findChatSearchMatches(
  db: ReadonlyDb,
  args: ChatSearchInput,
): Promise<ChatSearchMatchRow[]> {
  /**
   * Take up to 500 scoped keyword hits without ordering them, then sort only
   * those visible-thread candidates by time. This intentionally does not
   * find the newest hits across all history.
   */
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
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, chatEventSearchMessages.chatThreadId),
    )
    .where(
      and(
        chatSearchScope(args),
        sql`${chatEventSearchMessages.tsv} @@ to_tsquery('simple', ${tsquery})`,
      ),
    )
    // The inner LIMIT is a semantic boundary: ORDER BY applies only to its
    // candidates. It does not bound the work done by the GIN index or force a
    // particular physical index plan.
    .limit(CHAT_SEARCH_CANDIDATE_LIMIT)
    .as("chat_search_keyword_candidates");

  const newest = db
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
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(newest)
    .innerJoin(
      chatEventSearchMessages,
      and(
        eq(chatEventSearchMessages.chatThreadId, newest.chatThreadId),
        eq(chatEventSearchMessages.seqId, newest.seqId),
      ),
    )
    .leftJoin(chatThreads, eq(chatThreads.id, newest.chatThreadId))
    .leftJoin(
      projects,
      and(
        args.projectMetadata
          ? eq(projects.id, chatThreads.projectId)
          : sql`false`,
        eq(projects.orgId, args.orgId),
        eq(projects.userId, args.userId),
      ),
    )
    .orderBy(
      desc(newest.createdAt),
      desc(newest.chatThreadId),
      desc(newest.seqId),
    );

  return matches.flatMap((candidate): ChatSearchMatchRow[] => {
    if (
      candidate.existingChatThreadId === null ||
      (args.projectId !== undefined && candidate.projectId !== args.projectId)
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
        projectId: candidate.projectId,
        projectName: candidate.projectName,
      },
    ];
  });
}

export function chatSearch(
  input: ChatSearchInput | Computed<ChatSearchInput>,
): Computed<
  Promise<{
    readonly results: readonly (ChatSearchResult &
      Pick<ChatSearchMatchRow, "projectId" | "projectName">)[];
  }>
> {
  const input$ =
    "read" in input
      ? input
      : computed(() => {
          return input;
        });
  return computed(async (get) => {
    const args = get(input$);
    const db = get(db$);
    const matches = await findChatSearchMatches(db, args);

    const results = matches.map((match) => {
      const matchedMessage = toChatSearchMessage(match);
      return {
        chatThreadId: match.chatThreadId,
        projectId: match.projectId,
        projectName: match.projectName,
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
