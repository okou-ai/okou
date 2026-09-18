import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type {
  McpChatThread,
  McpGetChatThreadInput,
  McpGetChatThreadOutput,
  McpListChatThreadsInput,
  McpListChatThreadsOutput,
  McpThreadReadResult,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { agentDisplayName } from "@okouai/core/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  and,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  nullableDriverValueDecoder,
  pgBooleanDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import type { Db } from "../external/db";
import { safeJsonParse } from "../utils";
import { latestReadWatermarkEventSubquery } from "./chat-thread-read-state-query";
import { mcpChatThreadModels } from "./mcp-chat-thread-model.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
// PostgreSQL counts characters, while JSON schema string limits count UTF-16
// units. Five hundred code points fit the 1,000-unit response bound even for emoji.
const TEXT_CHARACTER_LIMIT = 500;
const UNREAD_COVERAGE = "retained_terminal_events_and_native_deliveries";
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
        activity: input.activity ?? null,
        unread: input.unread ?? null,
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

function activeRunCondition(
  db: Db,
  statuses: readonly ("queued" | "pending" | "running")[],
) {
  return exists(
    db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.chatThreadId, chatThreads.id),
          inArray(agentRuns.status, [...statuses]),
          isNotNull(agentRuns.triggerSource),
        ),
      ),
  );
}

function literalTitlePattern(title: string): string {
  return `%${title.replace(/[\\%_]/gu, String.raw`\$&`)}%`;
}

function threadQuery(
  db: Db,
  principal: Principal,
  input: McpListChatThreadsInput,
  cursor: Cursor | null,
  threadId?: string,
) {
  const active = activeRunCondition(db, ["queued", "pending", "running"]);
  const watermark = latestReadWatermarkEventSubquery(db, chatThreads.id);
  const unread = sql`${and(
    not(active),
    isNotNull(watermark.createdAt),
    or(
      isNull(chatThreads.lastReadAt),
      gt(watermark.createdAt, chatThreads.lastReadAt),
    ),
  )}`;
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
    input.activity === undefined
      ? undefined
      : input.activity === "active"
        ? active
        : not(active),
    input.unread === undefined
      ? undefined
      : input.unread
        ? unread
        : not(unread),
    cursor === null
      ? undefined
      : sql`(${chatThreads.lastMessageAt}, ${chatThreads.id}) < (${cursor.lastMessageAt}::timestamp, ${cursor.threadId}::uuid)`,
  ];
  return db
    .select({
      threadId: chatThreads.id,
      title: sql`left(${chatThreads.title}, ${TEXT_CHARACTER_LIMIT})`.mapWith(
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
      updatedAt: chatThreads.updatedAt,
      lastMessageAt: chatThreads.lastMessageAt,
      // Preserve all six timestamp digits in continuation, even though ordinary
      // response timestamps use the application's JavaScript Date representation.
      cursorTime:
        sql`to_char(${chatThreads.lastMessageAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.mapWith(
          pgTextDecoder,
        ),
      queued: activeRunCondition(db, ["queued"]).mapWith(pgBooleanDecoder),
      pending: activeRunCondition(db, ["pending"]).mapWith(pgBooleanDecoder),
      running: activeRunCondition(db, ["running"]).mapWith(pgBooleanDecoder),
      unread: unread.mapWith(pgBooleanDecoder),
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, agents.orgId))
    .leftJoinLateral(watermark, sql`true`)
    .where(and(...conditions))
    .orderBy(
      sql`${desc(chatThreads.lastMessageAt)} NULLS LAST`,
      sql`${desc(chatThreads.id)} NULLS LAST`,
    )
    .limit(threadId === undefined ? input.limit + 1 : 1);
}

type ThreadRow = Awaited<ReturnType<typeof threadQuery>>[number];

async function projectThreads(
  db: Db,
  principal: Principal,
  rows: readonly ThreadRow[],
): Promise<McpChatThread[]> {
  const models = await mcpChatThreadModels(
    db,
    principal,
    rows.map((row) => {
      return row.selectedModel;
    }),
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
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessageAt: row.lastMessageAt.toISOString(),
      url: new URL(`/chats/${row.threadId}`, env("APP_URL")).toString(),
      activity: {
        queued: row.queued,
        pending: row.pending,
        running: row.running,
      },
      unread: row.unread,
    };
  });
}

export async function listMcpChatThreads(
  db: Db,
  principal: Principal,
  input: McpListChatThreadsInput,
): Promise<McpThreadReadResult<McpListChatThreadsOutput>> {
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
  return await db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const rows = await threadQuery(tx, principal, input, cursor);
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
          threads: await projectThreads(tx, principal, page),
          nextCursor,
          unreadCoverage: UNREAD_COVERAGE,
        },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function getMcpChatThread(
  db: Db,
  principal: Principal,
  input: McpGetChatThreadInput,
): Promise<McpThreadReadResult<McpGetChatThreadOutput>> {
  return await db.transaction(
    async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const rows = await threadQuery(
        tx,
        principal,
        { limit: 1 },
        null,
        input.threadId,
      );
      if (rows.length === 0) {
        return {
          kind: "not_found" as const,
          message:
            "Chat thread not found or unavailable. Use list_chat_threads to find accessible threads.",
        };
      }
      const [thread] = await projectThreads(tx, principal, rows);
      if (!thread) {
        throw new Error("MCP thread projection is missing");
      }
      return {
        kind: "ok" as const,
        data: { thread, unreadCoverage: UNREAD_COVERAGE },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
