import type { McpSearchChatMessagesInput } from "@okouai/api-contracts/contracts/mcp-chat-search";
import { agents } from "@okouai/db/schema/agent";
import { chatEventSearchMessages } from "@okouai/db/schema/chat-event-search";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { ReadonlyDb } from "../external/db";

export const MCP_SEARCH_CANDIDATE_LIMIT = 100;
interface McpSearchPosition {
  readonly createdAt: string;
  readonly threadId: string;
  readonly seqId: number;
}

/** SQL ownership/filtering precedes LIMIT; content hashing follows it. */
export function mcpChatSearchCandidates(
  db: ReadonlyDb,
  principal: { readonly userId: string; readonly orgId: string },
  input: McpSearchChatMessagesInput,
  tsquery: string,
  cursor: McpSearchPosition | null,
) {
  const source = chatEventSearchMessages;
  const columns = {
    threadId: source.chatThreadId,
    seqId: source.seqId,
    runId: source.runId,
    agentId: source.agentId,
    role: source.role,
    createdAt: source.createdAt,
    text: source.text,
  };
  const keywordQuery = db
    .select(columns)
    .from(source)
    .where(
      and(
        eq(source.userId, principal.userId),
        eq(source.orgId, principal.orgId),
        sql`${source.tsv} @@ to_tsquery('simple', ${tsquery})`,
        input.threadId === undefined
          ? undefined
          : eq(source.chatThreadId, input.threadId),
        input.agentId === undefined
          ? undefined
          : eq(source.agentId, input.agentId),
        input.role === undefined ? undefined : eq(source.role, input.role),
        input.since === undefined
          ? undefined
          : gte(source.createdAt, sql`${input.since}::timestamp`),
        input.before === undefined
          ? undefined
          : lt(source.createdAt, sql`${input.before}::timestamp`),
        cursor === null
          ? undefined
          : sql`(${source.createdAt}, ${source.chatThreadId}, ${source.seqId}) < (${cursor.createdAt}::timestamp, ${cursor.threadId}::uuid, ${cursor.seqId}::bigint)`,
      ),
    );
  // Keep the Top-N sort outside the complete lexical match. Otherwise rare
  // terms can make an ordered recency plan walk the entire user's history.
  const keyword = db
    .$with("mcp_search_keyword", columns)
    .as(sql`${keywordQuery} OFFSET 0`);
  const page = db
    .select({
      threadId: keyword.threadId,
      seqId: keyword.seqId,
      runId: keyword.runId,
      role: keyword.role,
      createdAt: keyword.createdAt,
      text: keyword.text,
      title: sql`left(${chatThreads.title}, 500)`
        .mapWith(nullableDriverValueDecoder(chatThreads.title))
        .as("bounded_title"),
      titleTruncated: sql`coalesce(length(${chatThreads.title}) > 500, false)`
        .mapWith(pgBooleanDecoder)
        .as("title_truncated"),
      agentId: agents.id,
      agentName: agents.name,
      agentDisplayName: agents.displayName,
      defaultAgentId: orgMetadata.defaultAgentId,
    })
    .from(keyword)
    .innerJoin(
      chatThreads,
      and(
        eq(chatThreads.id, keyword.threadId),
        eq(chatThreads.userId, principal.userId),
        eq(chatThreads.agentId, keyword.agentId),
      ),
    )
    .innerJoin(
      agents,
      and(
        eq(agents.id, chatThreads.agentId),
        eq(agents.orgId, principal.orgId),
      ),
    )
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
    .orderBy(
      desc(keyword.createdAt),
      desc(keyword.threadId),
      desc(keyword.seqId),
    )
    .limit(MCP_SEARCH_CANDIDATE_LIMIT + 1)
    .as("mcp_search_page");
  return db
    .with(keyword)
    .select({
      threadId: page.threadId,
      seqId: page.seqId,
      runId: page.runId,
      role: page.role,
      createdAt:
        sql`to_char(${page.createdAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
          pgTextDecoder,
        ),
      // No body crosses the DB boundary. Do not detoast/hash an unbounded body;
      // a null fingerprint is an explicit resource failure for this candidate.
      textHash:
        sql`CASE WHEN octet_length(${page.text}) <= 33554432 THEN encode(sha256(convert_to(${page.text}, 'UTF8')), 'hex') ELSE NULL END`.mapWith(
          nullableDriverValueDecoder(pgTextDecoder),
        ),
      threadTitle: page.title,
      titleTruncated: page.titleTruncated,
      agentId: page.agentId,
      agentName: page.agentName,
      agentDisplayName: page.agentDisplayName,
      defaultAgentId: page.defaultAgentId,
    })
    .from(page)
    .orderBy(desc(page.createdAt), desc(page.threadId), desc(page.seqId));
}

export type McpSearchCandidate = Awaited<
  ReturnType<typeof mcpChatSearchCandidates>
>[number];
