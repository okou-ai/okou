import { chatAgentphoneContext } from "@okouai/db/schema/chat-agentphone-context";
import { chatDiscordContext } from "@okouai/db/schema/chat-discord-context";
import { chatFeishuContext } from "@okouai/db/schema/chat-feishu-context";
import { chatSlackContext } from "@okouai/db/schema/chat-slack-context";
import { chatTeamsContext } from "@okouai/db/schema/chat-teams-context";
import { chatTelegramContext } from "@okouai/db/schema/chat-telegram-context";
import { discordChatIngress } from "@okouai/db/schema/discord-chat-ingress";
import { feishuChatIngress } from "@okouai/db/schema/feishu-chat-ingress";
import { slackChatIngress } from "@okouai/db/schema/slack-chat-ingress";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import {
  eq,
  and,
  exists,
  getTableColumns,
  sql,
  type InferInsertModel,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder, type PgTable } from "drizzle-orm/pg-core";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  chatThreadEvents,
  chatThreadEventSequences,
} from "@okouai/db/schema/chat-thread-event";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { prepareChatEvent } from "./chat-event.service";
import type { ThreadModelReplacement } from "./chat-input-model.service";
import {
  canonicalChatEventAppendCtes,
  chatEventAppendResultSchema,
} from "./chat-event-append.service";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import { queuedChatThreadEnqueuePlan } from "./queued-chat-thread.service";
import { chatThreadServiceTierFromCodex } from "./chat-thread-event.service";

type IntegrationIngressReceipt =
  | {
      readonly kind: "discord";
      readonly ingressId: string;
      readonly routeId: string;
      readonly claimToken: string;
    }
  | { readonly kind: "slack" | "feishu"; readonly ingressId: string };

type IntegrationContext = Exclude<
  NonNullable<ReturnType<typeof prepareChatEvent>["displayContext"]>,
  { readonly type: "agent_run" | "automation" }
>;

/** The provider context row the integration input references. */
function integrationContextSql(
  context: IntegrationContext,
  chatThreadId: string,
  createdAt: Date,
): SQL {
  if (context.type === "wechat") {
    throw new Error("WeChat inputs use their atomic statement writer");
  }
  if (context.type === "discord") {
    return gatedIntegrationContextSql(
      chatDiscordContext,
      {
        ...context.snapshot,
        id: context.id,
        chatThreadId,
        createdAt,
      },
      sql`(id)`,
    );
  } else if (context.type === "slack") {
    return gatedIntegrationContextSql(chatSlackContext, {
      ...context,
      createdAt,
    });
  } else if (context.type === "feishu") {
    return gatedIntegrationContextSql(chatFeishuContext, {
      ...context,
      createdAt,
    });
  } else if (context.type === "teams") {
    return gatedIntegrationContextSql(chatTeamsContext, {
      ...context,
      createdAt,
    });
  } else if (context.type === "telegram") {
    return gatedIntegrationContextSql(chatTelegramContext, {
      ...context,
      createdAt,
    });
  }
  return gatedIntegrationContextSql(chatAgentphoneContext, {
    ...context,
    createdAt,
  });
}

function discordIntegrationClaimPlan(
  ingress: Extract<IntegrationIngressReceipt, { readonly kind: "discord" }>,
  currentTime: Date,
) {
  return {
    values: {
      status: "processed" as const,
      claimToken: null,
      claimedAt: null,
      retryAt: null,
      lastErrorClass: null,
      lastError: null,
      updatedAt: currentTime,
    },
    condition: and(
      eq(discordChatIngress.id, ingress.ingressId),
      eq(discordChatIngress.status, "processing"),
      eq(discordChatIngress.claimToken, ingress.claimToken),
      eq(discordChatIngress.routeId, ingress.routeId),
    ),
  };
}

function integrationModelChangePlan(
  replacement: ThreadModelReplacement,
  currentTime: Date,
) {
  return {
    values: {
      selectedModel: replacement.selectedModel,
      ...(replacement.codexServiceTier !== replacement.replacedCodexServiceTier
        ? { codexServiceTier: replacement.codexServiceTier }
        : {}),
      updatedAt: currentTime,
    },
    condition: and(
      eq(chatThreads.id, replacement.chatThreadId),
      eq(chatThreads.userId, replacement.userId),
      eq(chatThreads.selectedModel, replacement.replacedModel),
      exists(new QueryBuilder().select().from(sql`inserted`)),
      sql`(SELECT count(*) FROM settled_feishu) >= 0`,
    ),
  };
}

/** Keep partial INSERT targets and each schema encoder; omitted values retain
 * their database defaults. Drizzle's INSERT SELECT requires every column. */
function gatedIntegrationContextSql<T extends PgTable>(
  table: T,
  values: InferInsertModel<T>,
  conflictTarget: SQL = sql.empty(),
): SQL {
  const columns = getTableColumns(table);
  const entries = Object.entries(values).flatMap(([key, value]) => {
    const column = columns[key];
    return column !== undefined && value !== undefined
      ? [{ column, value }]
      : [];
  });
  const names = entries.map(({ column }) => {
    return sql.identifier(column.name);
  });
  const parameters = entries.map(({ column, value }) => {
    return sql.param(value, column);
  });
  return sql`INSERT INTO ${table} (${sql.join(names, sql`, `)})
    SELECT ${sql.join(parameters, sql`, `)} FROM claimed_ingress
    ON CONFLICT ${conflictTarget} DO NOTHING RETURNING id`;
}

/** One reservation owns both model and optional tier events, in that order. */
function integrationModelReplacementSql(
  replacement: ThreadModelReplacement | null,
  updatedAt: Date,
  changed: SQL,
): SQL {
  if (!replacement) {
    return sql`model_events AS (SELECT id FROM inserted WHERE false)`;
  }
  const tierChanged =
    replacement.codexServiceTier !== replacement.replacedCodexServiceTier;
  const count = tierChanged ? 2 : 1;
  const modelId = randomUUID();
  const tierId = randomUUID();
  const tier = chatThreadServiceTierFromCodex(replacement.codexServiceTier);
  return sql`model_changed AS (${changed}),
    model_reserved AS (
      INSERT INTO ${chatThreadEventSequences} (user_id, org_id, last_seq_id)
      SELECT ${replacement.userId}, ${replacement.orgId}, ${count} FROM model_changed
      ON CONFLICT (user_id, org_id) DO UPDATE
        SET last_seq_id = ${chatThreadEventSequences.lastSeqId} + ${count}
      RETURNING last_seq_id
    ), model_events AS (
      INSERT INTO ${chatThreadEvents}
        (id, user_id, org_id, seq_id, chat_thread_id, kind, agent_id,
         selected_model, service_tier, cloud_browser_enabled, created_at)
      SELECT CASE WHEN event.ordinal = 0 THEN ${modelId}::uuid ELSE ${tierId}::uuid END,
        ${replacement.userId}, ${replacement.orgId},
        model_reserved.last_seq_id - ${count} + 1 + event.ordinal,
        ${replacement.chatThreadId}::uuid,
        CASE WHEN event.ordinal = 0 THEN 'model_selection_updated'::chat_thread_event_kind
          ELSE 'service_tier_updated'::chat_thread_event_kind END,
        ${replacement.agentId}::uuid,
        CASE WHEN event.ordinal = 0 THEN ${replacement.selectedModel} ELSE NULL END,
        CASE WHEN event.ordinal = 1 THEN ${tier} ELSE NULL END, false,
        ${sql.param(updatedAt, chatThreadEvents.createdAt)}
      FROM model_reserved CROSS JOIN (VALUES (0), (1)) AS event(ordinal)
      WHERE event.ordinal < ${count}
      ON CONFLICT (id) DO NOTHING RETURNING id
    )`;
}

/**
 * One integration input, its context, its thread's model replacement and the
 * existing ingress receipt commit together.
 */
export const enqueueIntegrationChatInput$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly input: Parameters<typeof prepareChatEvent>[0];
      readonly threadModelReplacement: ThreadModelReplacement | null;
      readonly ingress?: IntegrationIngressReceipt;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const prepared = prepareChatEvent(args.input);
    const context = prepared.displayContext;
    if (
      !context ||
      context.type === "agent_run" ||
      context.type === "automation"
    ) {
      throw new Error("Integration input requires its provider context");
    }
    const { createdAt, chatThreadId } = prepared.row;
    const currentTime = nowDate();
    signal.throwIfAborted();
    let claim = sql`SELECT 1 AS id`;
    if (args.ingress?.kind === "discord") {
      const plan = discordIntegrationClaimPlan(args.ingress, currentTime);
      claim = db
        .update(discordChatIngress)
        .set(plan.values)
        .where(plan.condition)
        .returning({ id: discordChatIngress.id })
        .getSQL();
    } else if (args.ingress?.kind === "slack") {
      claim = db
        .update(slackChatIngress)
        .set({
          status: "processed",
          retryAt: null,
          lastErrorClass: null,
          lastError: null,
          updatedAt: currentTime,
        })
        .where(
          and(
            eq(slackChatIngress.id, args.ingress.ingressId),
            eq(slackChatIngress.status, "processing"),
          ),
        )
        .returning({ id: slackChatIngress.id })
        .getSQL();
    }
    const contextWrite = integrationContextSql(
      context,
      chatThreadId,
      createdAt,
    );
    const replacement = args.threadModelReplacement;
    const modelPlan = replacement
      ? integrationModelChangePlan(replacement, currentTime)
      : null;
    const modelChanged = modelPlan
      ? db
          .update(chatThreads)
          .set(modelPlan.values)
          .where(modelPlan.condition)
          .returning({ id: chatThreads.id })
          .getSQL()
      : sql`SELECT id FROM inserted WHERE false`;
    const receipt =
      args.ingress?.kind === "feishu"
        ? db
            .update(feishuChatIngress)
            .set({
              status: "processed",
              lastError: null,
              updatedAt: currentTime,
            })
            .where(
              and(
                eq(feishuChatIngress.id, args.ingress.ingressId),
                eq(feishuChatIngress.status, "processing"),
                sql`(SELECT count(*) FROM inserted) >= 0`,
              ),
            )
            .returning({ id: feishuChatIngress.id })
            .getSQL()
        : sql`SELECT id FROM inserted WHERE false`;
    const queue = queuedChatThreadEnqueuePlan({
      chatThreadId,
      orgId: args.orgId,
    });
    // Dependencies preserve ingress -> context -> event -> model -> queue.
    // A conflicting context still permits the canonical event attempt; only its
    // returned identity may replace the model or advance the queue's timestamp.
    const [event] = parseRawRows(
      chatEventAppendResultSchema,
      await db.execute(sql`
      WITH claimed_ingress AS (${claim}),
      integration_context AS (${contextWrite}),
      ${canonicalChatEventAppendCtes(
        [prepared.row],
        "id",
        sql`
        EXISTS (SELECT 1 FROM claimed_ingress)
        AND (SELECT count(*) FROM integration_context) >= 0`,
      )},
      settled_feishu AS (${receipt}),
      ${integrationModelReplacementSql(replacement, currentTime, modelChanged)},
      queued AS (
        INSERT INTO ${queuedChatThreads} (chat_thread_id, org_id, queued_at)
        SELECT ${chatThreadId}::uuid, ${args.orgId},
          ${sql.param(queue.values.queuedAt, queuedChatThreads.queuedAt)} FROM inserted
        WHERE (SELECT count(*) FROM settled_feishu) >= 0
          AND (SELECT count(*) FROM model_events) >= 0
        ON CONFLICT (chat_thread_id) DO UPDATE
          SET queued_at = ${queue.conflict.set.queuedAt}
      )
      SELECT id, created_at::text AS "createdAt", seq_id AS "seqId",
        run_event_sequence_number AS "sequenceNumber" FROM inserted
    `),
    );
    signal.throwIfAborted();
    return event?.id ?? null;
  },
);
