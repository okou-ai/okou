import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  McpChatSearchMatch,
  McpChatSearchResult,
  McpSearchChatMessagesInput,
} from "@okouai/api-contracts/contracts/mcp-chat-search";
import { isRetiredGoalArchiveText } from "@okouai/api-contracts/contracts/retired-goal-archive";
import { agentDisplayName } from "@okouai/core/public-brand";
import { computed, type Computed } from "ccstate";
import { sql } from "drizzle-orm";
import { z } from "zod";

import {
  chatSearchBigramTsquery,
  chatSearchFirstMatchRange,
} from "../../lib/chat-search-bigram";
import { env } from "../../lib/env";
import { safeSqlStateCode } from "../../lib/pg-errors";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { awaitWithSignal, safeJsonParse, settle } from "../utils";
import {
  createMcpChatHistoryBudget,
  McpMessageHistoryError,
  readMcpChatMessageHistory,
} from "./mcp-chat-message-history.service";
import { projectMcpChatMessages } from "./mcp-chat-messages.service";
import {
  MCP_SEARCH_CANDIDATE_LIMIT,
  mcpChatSearchCandidates,
  type McpSearchCandidate,
} from "./mcp-chat-search-query";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}
type Message = ReturnType<typeof projectMcpChatMessages>[number];
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const OUTPUT_BYTES = 160 * 1024;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  userId: z.string(),
  orgId: z.string(),
  filters: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  createdAt: z.iso.datetime({ precision: 6 }),
  threadId: z.uuid(),
  seqId: z.number().int().positive(),
});
type Cursor = z.infer<typeof cursorSchema>;

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function sign(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("mcp:search_chat_messages:v1\n")
    .update(payload)
    .digest();
}
function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  const token = `${payload}.${sign(payload).toString("base64url")}`;
  if (token.length > 4096) {
    throw new McpMessageHistoryError(
      "history_limit",
      "Search identity exceeds the supported cursor size.",
    );
  }
  return token;
}
function decodeCursor(
  token: string,
  principal: Principal,
  filters: string,
): Cursor | null {
  const [payload, signature, extra] = token.split(".");
  if (
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    !/^[A-Za-z0-9_-]+$/u.test(signature)
  ) {
    return null;
  }
  const actual = Buffer.from(signature, "base64url");
  const expected = sign(payload);
  if (
    actual.toString("base64url") !== signature ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    return null;
  }
  const parsed = cursorSchema.safeParse(
    safeJsonParse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (!parsed.success) {
    return null;
  }
  const cursor = parsed.data;
  return cursor.userId === principal.userId &&
    cursor.orgId === principal.orgId &&
    cursor.filters === filters &&
    cursor.issuedAt <= now() &&
    cursor.expiresAt > now() &&
    cursor.expiresAt - cursor.issuedAt === CURSOR_TTL_MS
    ? cursor
    : null;
}

function safeBoundary(text: string, offset: number): number {
  const previous = text.charCodeAt(offset - 1);
  const unit = text.charCodeAt(offset);
  return previous >= 0xd8_00 &&
    previous <= 0xdb_ff &&
    unit >= 0xdc_00 &&
    unit <= 0xdf_ff
    ? offset - 1
    : offset;
}

function searchMatch(
  candidate: McpSearchCandidate,
  message: Message,
  query: string,
): McpChatSearchMatch | null {
  if (message.role !== candidate.role || message.runId !== candidate.runId) {
    return null;
  }
  const indexedText =
    message.role === "assistant" &&
    message.runId === null &&
    isRetiredGoalArchiveText(message.text)
      ? message.text
      : message.text.trim();
  if (hash(indexedText) !== candidate.textHash) {
    return null;
  }
  const range = chatSearchFirstMatchRange(message.text, query);
  if (!range) {
    return null;
  }
  const start = safeBoundary(message.text, Math.max(0, range.start - 200));
  const end = safeBoundary(
    message.text,
    Math.min(message.text.length, start + 1000),
  );
  const name =
    agentDisplayName({
      agentId: candidate.agentId,
      defaultAgentId: candidate.defaultAgentId,
      displayName: candidate.agentDisplayName,
    }) ?? candidate.agentName;
  return {
    ref: message.ref,
    threadTitle: candidate.threadTitle,
    titleTruncated: candidate.titleTruncated,
    agent: { agentId: candidate.agentId, name },
    role: message.role,
    runId: message.runId,
    createdAt: candidate.createdAt,
    excerpt: {
      text: message.text.slice(start, end),
      offset: start,
      hasBefore: start > 0,
      hasAfter: end < message.text.length,
    },
    url: message.url,
  };
}

interface SearchRuntime {
  readonly db: Db;
  readonly bucket: string;
  readonly historyBudget: ReturnType<typeof createMcpChatHistoryBudget>;
}

function searchHistory(
  runtime: SearchRuntime,
  principal: Principal,
  candidates: readonly McpSearchCandidate[],
  threadId: string,
  signal: AbortSignal,
): Computed<Promise<Map<number, Message>>> {
  return computed(async (get) => {
    const history = await get(
      readMcpChatMessageHistory(runtime, principal, threadId, signal),
    );
    runtime.historyBudget.check();
    const wanted = new Set(
      candidates
        .filter((row) => {
          return row.threadId === threadId;
        })
        .map((row) => {
          return row.seqId;
        }),
    );
    return new Map(
      (history === null
        ? []
        : projectMcpChatMessages(history, runtime.historyBudget.check)
      )
        .filter((message) => {
          return wanted.has(message.ref.seqId);
        })
        .map((message) => {
          return [message.ref.seqId, message];
        }),
    );
  });
}

function searchPage(
  runtime: SearchRuntime,
  principal: Principal,
  input: McpSearchChatMessagesInput,
  query: {
    readonly tsquery: string;
    readonly cursor: Cursor | null;
    readonly filters: string;
  },
  signal: AbortSignal,
): Computed<Promise<McpChatSearchResult>> {
  return computed(async (get): Promise<McpChatSearchResult> => {
    const { tsquery, cursor, filters } = query;
    const budget = runtime.historyBudget;
    const candidates = await awaitWithSignal(
      runtime.db.transaction(
        async (tx) => {
          budget.check();
          await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
          budget.check();
          return await mcpChatSearchCandidates(
            tx,
            principal,
            input,
            tsquery,
            cursor,
          );
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
      signal,
    );
    budget.check();
    // This is request-local grouping of distinct candidate identities, not
    // a cache across reactive reads or authorization changes.
    const byThread = new Map<string, Map<number, Message>>();
    const matches: McpChatSearchMatch[] = [];
    let consumed = 0;
    let last: McpSearchCandidate | undefined;
    const issuedAt = cursor?.issuedAt ?? now();
    const continuation = (candidate: McpSearchCandidate) => {
      return encodeCursor({
        version: 1,
        userId: principal.userId,
        orgId: principal.orgId,
        filters,
        issuedAt,
        expiresAt: issuedAt + CURSOR_TTL_MS,
        createdAt: candidate.createdAt,
        threadId: candidate.threadId,
        seqId: candidate.seqId,
      });
    };
    for (const candidate of candidates.slice(0, MCP_SEARCH_CANDIDATE_LIMIT)) {
      budget.check();
      if (matches.length >= input.limit) {
        break;
      }
      if (candidate.textHash === null) {
        throw new McpMessageHistoryError(
          "history_limit",
          "An indexed message exceeds the supported search byte limit.",
        );
      }
      let messages = byThread.get(candidate.threadId);
      if (!messages) {
        messages = await get(
          searchHistory(
            runtime,
            principal,
            candidates,
            candidate.threadId,
            signal,
          ),
        );
        budget.check();
        byThread.set(candidate.threadId, messages);
      }
      const message = messages.get(candidate.seqId);
      const match = message
        ? searchMatch(candidate, message, input.query)
        : null;
      budget.check();
      // Even a skipped candidate can enlarge the cursor (for example, a longer
      // sequence number). Reserve the final payload before consuming each row.
      const data = {
        matches: match ? [...matches, match] : matches,
        nextCursor: continuation(candidate),
        scanLimited: false,
      };
      if (Buffer.byteLength(JSON.stringify(data)) > OUTPUT_BYTES) {
        if (matches.length === 0) {
          throw new McpMessageHistoryError(
            "history_limit",
            "Search result metadata exceeds the supported output size.",
          );
        }
        break;
      }
      if (match) {
        matches.push(match);
      }
      consumed += 1;
      last = candidate;
    }
    budget.check();
    const hasMore = consumed < candidates.length;
    return {
      kind: "ok",
      data: {
        matches,
        nextCursor: hasMore && last ? continuation(last) : null,
        scanLimited: hasMore && consumed === MCP_SEARCH_CANDIDATE_LIMIT,
      },
    };
  });
}

/** Bounded index discovery followed by the same canonical visibility as context reads. */
export function searchMcpChatMessages(
  runtime: { readonly db: Db; readonly bucket: string },
  principal: Principal,
  input: McpSearchChatMessagesInput,
  signal: AbortSignal,
): Computed<Promise<McpChatSearchResult>> {
  return computed(async (get): Promise<McpChatSearchResult> => {
    const tsquery = chatSearchBigramTsquery(input.query);
    if (tsquery === null) {
      return {
        kind: "invalid_query",
        message:
          "Use words or CJK phrases of at least two characters. Punctuation-only and single-character CJK queries are not supported.",
      };
    }
    const filters = hash(
      JSON.stringify({
        query: input.query,
        threadId: input.threadId ?? null,
        agentId: input.agentId ?? null,
        role: input.role ?? null,
        since: input.since ?? null,
        before: input.before ?? null,
        limit: input.limit,
      }),
    );
    const cursor = input.cursor
      ? decodeCursor(input.cursor, principal, filters)
      : null;
    if (input.cursor && !cursor) {
      return {
        kind: "invalid_cursor",
        message:
          "The search cursor is invalid, expired, or belongs to different authorization, query, filters or limit. Restart without cursor.",
      };
    }
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const budget = createMcpChatHistoryBudget(operationSignal);
    const result = await settle(
      get(
        searchPage(
          { ...runtime, historyBudget: budget },
          principal,
          input,
          { tsquery, cursor, filters },
          operationSignal,
        ),
      ),
      signal,
    );
    signal.throwIfAborted();
    if (
      operationSignal.aborted ||
      (!result.ok &&
        ((result.error instanceof McpMessageHistoryError &&
          result.error.kind === "history_limit") ||
          safeSqlStateCode(result.error) === "57014"))
    ) {
      return {
        kind: "search_limit",
        message:
          "Search exceeded its candidate history, byte or time budget. Narrow the thread, Agent or time filters, or retry later. A smaller limit does not reduce one thread's reconstruction work.",
      };
    }
    if (!result.ok) {
      return {
        kind: "search_unavailable",
        message:
          "Search could not verify complete message history. Retry later; no partial result was returned.",
      };
    }
    return result.value;
  });
}
