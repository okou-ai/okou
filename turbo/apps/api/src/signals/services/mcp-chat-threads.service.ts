import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  McpChatThread,
  McpGetChatThreadInput,
  McpGetChatThreadOutput,
  McpListChatThreadsInput,
  McpListChatThreadsOutput,
  McpThreadReadResult,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { formatMcpChatTimestamp } from "@okouai/api-contracts/contracts/mcp-chat-time";
import { agentDisplayName } from "@okouai/core/brand-presentation";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, desc, eq, gte, ilike, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { command } from "ccstate";
import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { safeJsonParse } from "../utils";
import { mcpChatThreadModels$ } from "./mcp-chat-thread-model.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
// PostgreSQL counts characters, while JSON schema string limits count UTF-16
// units. Five hundred code points fit the 1,000-unit response bound even for emoji.
const TEXT_CHARACTER_LIMIT = 500;
const cursorSchema = z.strictObject({
  version: z.literal(1),
  operation: z.literal("list_chat_threads"),
  userId: z.string(),
  orgId: z.string(),
  filters: z.string(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  lastMessageAt: z.iso.datetime({ precision: 6 }),
  threadId: z.uuid(),
});
type Cursor = z.infer<typeof cursorSchema>;

function filterIdentity(input: McpListChatThreadsInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        agentId: input.agentId ?? null,
        title: input.title?.trim() ?? null,
        since: input.since ?? null,
        before: input.before ?? null,
      }),
    )
    .digest("hex");
}

function signCursor(payload: string): Buffer {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update("mcp:list_chat_threads:v1\n")
    .update(payload)
    .digest();
}

function encodeCursor(cursor: Cursor): string {
  const payload = Buffer.from(JSON.stringify(cursor), "utf8").toString(
    "base64url",
  );
  return `${payload}.${signCursor(payload).toString("base64url")}`;
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
  const expected = signCursor(payload);
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
  const currentTime = now();
  return cursor.userId === principal.userId &&
    cursor.orgId === principal.orgId &&
    cursor.filters === filters &&
    cursor.issuedAt <= currentTime &&
    cursor.expiresAt > currentTime &&
    cursor.expiresAt - cursor.issuedAt === CURSOR_TTL_MS
    ? cursor
    : null;
}

function literalTitlePattern(title: string): string {
  return `%${title.replace(/[\\%_]/gu, String.raw`\$&`)}%`;
}

const threadQuery$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpListChatThreadsInput;
      readonly cursor: Cursor | null;
      readonly threadId?: string;
    },
    signal: AbortSignal,
  ) => {
    const { principal, input, cursor, threadId } = args;
    const db = set(writeDb$);
    const conditions: (SQL | undefined)[] = [
      eq(chatThreads.userId, principal.userId),
      eq(agents.orgId, principal.orgId),
      threadId === undefined ? undefined : eq(chatThreads.id, threadId),
      input.agentId === undefined
        ? undefined
        : eq(chatThreads.agentId, input.agentId),
      input.title === undefined
        ? undefined
        : ilike(chatThreads.title, literalTitlePattern(input.title)),
      input.since === undefined
        ? undefined
        : gte(chatThreads.lastMessageAt, sql`${input.since}::timestamp`),
      input.before === undefined
        ? undefined
        : lt(chatThreads.lastMessageAt, sql`${input.before}::timestamp`),
      cursor === null
        ? undefined
        : sql`(${chatThreads.lastMessageAt}, ${chatThreads.id}) < (${cursor.lastMessageAt}::timestamp, ${cursor.threadId}::uuid)`,
    ];
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0184; new non-billing transactions are prohibited.
    const rows = await db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
        return await tx
          .select({
            threadId: chatThreads.id,
            title:
              sql`left(${chatThreads.title}, ${TEXT_CHARACTER_LIMIT})`.mapWith(
                nullableDriverValueDecoder(chatThreads.title),
              ),
            titleTruncated:
              sql`coalesce(length(${chatThreads.title}) > ${TEXT_CHARACTER_LIMIT}, false)`.mapWith(
                pgBooleanDecoder,
              ),
            agentId: agents.id,
            agentName: agents.name,
            agentDisplayName: agents.displayName,
            defaultAgentId: orgMetadata.defaultAgentId,
            selectedModel: chatThreads.selectedModel,
            createdAt: chatThreads.createdAt,
            metadataUpdatedAt: chatThreads.updatedAt,
            lastMessageAt: chatThreads.lastMessageAt,
            // Preserve all six stored digits in continuation. The public fields have
            // fixed six-digit syntax, but JavaScript Date projection has millisecond data.
            cursorTime:
              sql`to_char(${chatThreads.lastMessageAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
                pgTextDecoder,
              ),
          })
          .from(chatThreads)
          .innerJoin(agents, eq(agents.id, chatThreads.agentId))
          .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
          .where(and(...conditions))
          .orderBy(
            sql`${desc(chatThreads.lastMessageAt)} NULLS LAST`,
            sql`${desc(chatThreads.id)} NULLS LAST`,
          )
          .limit(threadId === undefined ? input.limit + 1 : 1);
      },
      { accessMode: "read only" },
    );
    signal.throwIfAborted();
    return rows;
  },
);

type ThreadRow = {
  readonly threadId: string;
  readonly title: string | null;
  readonly titleTruncated: boolean;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentDisplayName: string | null;
  readonly defaultAgentId: string | null;
  readonly selectedModel: string | null;
  readonly createdAt: Date;
  readonly metadataUpdatedAt: Date;
  readonly lastMessageAt: Date;
  readonly cursorTime: string;
};

const projectThreads$ = command(
  async (
    { set },
    principal: Principal,
    rows: readonly ThreadRow[],
    signal: AbortSignal,
  ): Promise<McpChatThread[]> => {
    const models = await set(
      mcpChatThreadModels$,
      principal,
      rows.map((row) => {
        return row.selectedModel;
      }),
      signal,
    );
    return rows.map((row) => {
      const model = models.get(row.selectedModel);
      if (!model) {
        throw new Error("MCP thread model projection is missing");
      }
      return {
        threadId: row.threadId,
        title: row.title,
        titleTruncated: row.titleTruncated,
        agent: {
          agentId: row.agentId,
          name:
            agentDisplayName({
              agentId: row.agentId,
              defaultAgentId: row.defaultAgentId,
              displayName: row.agentDisplayName,
            }) ?? row.agentName,
        },
        model,
        createdAt: formatMcpChatTimestamp(row.createdAt),
        metadataUpdatedAt: formatMcpChatTimestamp(row.metadataUpdatedAt),
        lastMessageAt: formatMcpChatTimestamp(row.lastMessageAt),
        url: new URL(`/chats/${row.threadId}`, env("APP_URL")).toString(),
      };
    });
  },
);

export const listMcpChatThreads$ = command(
  async (
    { set },
    principal: Principal,
    input: McpListChatThreadsInput,
    signal: AbortSignal,
  ): Promise<McpThreadReadResult<McpListChatThreadsOutput>> => {
    const filters = filterIdentity(input);
    const cursor = input.cursor
      ? decodeCursor(input.cursor, principal, filters)
      : null;
    if (input.cursor && !cursor) {
      return {
        kind: "invalid_cursor",
        message:
          "The thread cursor is invalid, expired, or belongs to different filters or authorization. Restart without cursor.",
      };
    }
    const rows = await set(threadQuery$, { principal, input, cursor }, signal);
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const issuedAt = cursor?.issuedAt ?? now();
    const nextCursor =
      rows.length > input.limit && last
        ? encodeCursor({
            version: 1,
            operation: "list_chat_threads",
            userId: principal.userId,
            orgId: principal.orgId,
            filters,
            issuedAt,
            expiresAt: issuedAt + CURSOR_TTL_MS,
            lastMessageAt: last.cursorTime,
            threadId: last.threadId,
          })
        : null;
    return {
      kind: "ok" as const,
      data: {
        threads: await set(projectThreads$, principal, page, signal),
        nextCursor,
      },
    };
  },
);

export const getMcpChatThread$ = command(
  async (
    { set },
    principal: Principal,
    input: McpGetChatThreadInput,
    signal: AbortSignal,
  ): Promise<McpThreadReadResult<McpGetChatThreadOutput>> => {
    const rows = await set(
      threadQuery$,
      {
        principal,
        input: { limit: 1 },
        cursor: null,
        threadId: input.threadId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (rows.length === 0) {
      return {
        kind: "not_found" as const,
        message:
          "Chat thread not found or unavailable. Use list_chat_threads to find accessible threads.",
      };
    }
    const [thread] = await set(projectThreads$, principal, rows, signal);
    if (!thread) {
      throw new Error("MCP thread projection is missing");
    }
    return {
      kind: "ok" as const,
      data: { thread },
    };
  },
);
