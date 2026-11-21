import { command, computed } from "ccstate";
import {
  and,
  desc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNull,
  lt,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { v5 as uuidv5 } from "uuid";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatEmailContext } from "@okouai/db/schema/email-integration";
import { chatWechatContext } from "@okouai/db/schema/wechat";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  canonicalChatEventAppendCtes,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";

const CONTEXT_TABLES = Object.freeze({
  slack: chatSlackContext,
  discord: chatDiscordContext,
  feishu: chatFeishuContext,
  teams: chatTeamsContext,
  telegram: chatTelegramContext,
  agentphone: chatAgentphoneContext,
  email: chatEmailContext,
  wechat: chatWechatContext,
});

export interface IntegrationRecoveryIdentity {
  readonly eventId: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface IntegrationRecoveryInput extends IntegrationRecoveryIdentity {
  readonly chatThreadId: string;
  readonly selectedModel: string;
  readonly contextType: keyof typeof CONTEXT_TABLES;
  readonly createdAt: Date;
}

function isRecoveryContextType(
  value: string,
): value is keyof typeof CONTEXT_TABLES {
  return Object.hasOwn(CONTEXT_TABLES, value);
}

const newer = alias(chatEvents, "recovery_newer_event");
const pending = alias(chatEvents, "recovery_pending_input");
const revoker = alias(chatEvents, "recovery_input_revoker");

/** A recovery must not revive a conversation the user already continued or stopped. */
export function unchangedFailedIntegrationConversation(): SQL {
  const query = new QueryBuilder();
  return sql`${notExists(
    query
      .select({ id: newer.id })
      .from(newer)
      .where(
        and(
          eq(newer.chatThreadId, chatEvents.chatThreadId),
          gt(newer.seqId, chatEvents.seqId),
          inArray(newer.eventType, [
            "input.prompt",
            "input.rejected",
            "input.automation",
            "input.budget",
            "run.completed",
            "run.failed",
            "run.cancelled",
            "control.interrupt",
            "control.revoke",
            "output.error",
          ]),
        ),
      ),
  )} AND ${notExists(
    query
      .select({ id: pending.id })
      .from(pending)
      .where(
        and(
          eq(pending.chatThreadId, chatEvents.chatThreadId),
          isNull(pending.runId),
          inArray(pending.eventType, [
            "input.prompt",
            "input.automation",
            "input.budget",
          ]),
          notExists(
            query
              .select({ id: revoker.id })
              .from(revoker)
              .where(eq(revoker.revokesEventId, pending.id)),
          ),
        ),
      ),
  )} AND ${notExists(query.select({ id: activeAgentRuns.runId }).from(activeAgentRuns).where(eq(activeAgentRuns.chatThreadId, chatEvents.chatThreadId)))}`;
}

export function integrationRecoverySource(args: IntegrationRecoveryIdentity) {
  return computed(async (get) => {
    const database = get(db$);
    const [failure] = await database
      .select({
        threadId: chatThreads.id,
        selectedModel: chatThreads.selectedModel,
        updatedAt: sql`${chatThreads.updatedAt}::text`.mapWith(pgTextDecoder),
        seqId: chatEvents.seqId,
        runId: chatEvents.runId,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .where(
        and(
          eq(chatEvents.id, args.eventId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.orgId, args.orgId),
          eq(chatThreads.archived, false),
          inArray(chatEvents.eventType, ["run.failed", "output.error"]),
          unchangedFailedIntegrationConversation(),
        ),
      )
      .limit(1);
    if (!failure) {
      return null;
    }
    const [source] = await database
      .select({
        contextType: chatEvents.contextType,
        contextId: chatEvents.contextId,
      })
      .from(chatEvents)
      .where(
        and(
          eq(chatEvents.chatThreadId, failure.threadId),
          lt(chatEvents.seqId, failure.seqId),
          failure.runId ? eq(chatEvents.runId, failure.runId) : undefined,
          inArray(chatEvents.eventType, ["input.prompt", "input.rejected"]),
        ),
      )
      .orderBy(desc(chatEvents.seqId))
      .limit(1);
    if (
      !source?.contextId ||
      !source.contextType ||
      !isRecoveryContextType(source.contextType)
    ) {
      return null;
    }
    return {
      ...failure,
      ...source,
      contextId: source.contextId,
      contextType: source.contextType,
    };
  });
}

/** Copy the frozen route/history, replacing only this new input and obsolete indicators. */
function recoveryContextSql(
  table: PgTable,
  sourceId: string,
  id: string,
  createdAt: Date,
): SQL {
  const columns = Object.entries(getTableColumns(table));
  return sql`INSERT INTO ${table} (${sql.join(
    columns.map(([, column]) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )})
    SELECT ${sql.join(
      columns.map(([key, column]) => {
        if (key === "id") {
          return sql`${id}::uuid`;
        }
        if (key === "createdAt") {
          return sql.param(createdAt, column);
        }
        if (key === "messageText") {
          return sql`'continue'`;
        }
        if (key === "messageTs") {
          // Slack Stop compares input time with its event time. A delayed Stop
          // for the failed Run must not cancel this new automatic input.
          return sql`${(createdAt.getTime() / 1000).toFixed(6)}`;
        }
        if (key === "reactionId" || key === "thinkingMessageId") {
          return sql`NULL`;
        }
        return sql`${column}`;
      }),
      sql`, `,
    )} FROM ${table}
    WHERE id = ${sourceId}::uuid AND EXISTS (SELECT 1 FROM eligible_failure)
    ON CONFLICT (id) DO NOTHING RETURNING id`;
}

export const enqueueIntegrationRecovery$ = command(
  async (
    { get, set },
    args: IntegrationRecoveryIdentity & { readonly selectedModel: string },
    signal: AbortSignal,
  ): Promise<IntegrationRecoveryInput | null> => {
    const source = await get(integrationRecoverySource(args));
    signal.throwIfAborted();
    if (!source || source.selectedModel !== args.selectedModel) {
      return null;
    }
    const contextType = source.contextType;
    const table = CONTEXT_TABLES[contextType];
    const model = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: source.threadId,
        orgId: args.orgId,
        userId: args.userId,
      },
      signal,
    );
    const id = uuidv5("integration-model-recovery", args.eventId);
    const contextId = contextType === "wechat" ? source.contextId : id;
    const createdAt = nowDate();
    const contextWrite =
      contextType === "wechat"
        ? sql`SELECT id FROM ${table} WHERE id = ${source.contextId}::uuid AND EXISTS (SELECT 1 FROM eligible_failure)`
        : recoveryContextSql(table, source.contextId, contextId, createdAt);
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId: source.threadId,
      orgId: args.orgId,
    });
    const database = set(writeDb$);
    const [event] = parseRawRows(
      chatEventAppendResultSchema,
      await database.execute(sql`
      WITH eligible_failure AS (
        SELECT ${chatEvents.id} FROM ${chatEvents}
        INNER JOIN ${chatThreads} ON ${chatThreads.id} = ${chatEvents.chatThreadId}
        WHERE ${chatEvents.id} = ${args.eventId}::uuid
          AND ${chatThreads.userId} = ${args.userId}
          AND ${chatThreads.selectedModel} = ${args.selectedModel}
          AND ${chatThreads.updatedAt} = ${source.updatedAt}::timestamp
          AND NOT ${chatThreads.archived}
          AND ${unchangedFailedIntegrationConversation()}
      ), recovery_context AS (${contextWrite}),
      ${canonicalChatEventAppendCtes(
        [
          {
            id,
            chatThreadId: source.threadId,
            eventType: "input.prompt",
            payload: {
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: "continue" }],
              },
            },
            modelSelection: model.modelSelection,
            contextType,
            contextId,
            createdAt,
          },
        ],
        "id",
        sql`EXISTS (SELECT 1 FROM eligible_failure) AND (EXISTS (SELECT 1 FROM recovery_context) OR EXISTS (SELECT 1 FROM ${table} WHERE id = ${contextId}::uuid))`,
      )},
      queued AS (
        INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
        SELECT ${source.threadId}::uuid, ${args.orgId}, ${sql.param(queue.values.queuedAt, queuedChatThreads.queuedAt)} FROM inserted
        ON CONFLICT (chat_thread_id) DO UPDATE SET queued_at = ${queue.conflict.set.queuedAt}
      ) SELECT id, created_at::text AS "createdAt", seq_id AS "seqId",
        run_event_sequence_number AS "sequenceNumber" FROM inserted
    `),
    );
    signal.throwIfAborted();
    return event
      ? {
          orgId: args.orgId,
          userId: args.userId,
          selectedModel: args.selectedModel,
          eventId: event.id,
          chatThreadId: source.threadId,
          contextType,
          createdAt,
        }
      : null;
  },
);
