import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { createHash, randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  wechatConnections,
  wechatChatThreadRoutes,
  chatWechatContext,
} from "@okouai/db/schema/wechat";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { writeDb$ } from "../external/db";
import type { WechatMessage } from "../external/wechat-client";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadValues,
  integrationChatThreadInsertFromRouteSql,
  integrationThreadCreatedEventSql,
} from "./integration-chat-thread-publication";
import { resolveDefaultModelFirstPin$ } from "./model-selection.service";
import {
  resolveEnqueuedChatInputModel$,
  type ThreadModelReplacement,
} from "./chat-input-model.service";
import { chatThreadServiceTierFromCodex } from "./chat-thread-event.service";
import { createUserMessageDocument } from "./chat-user-message.service";
import { prepareChatEvent } from "./chat-event.service";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";

type Connection = typeof wechatConnections.$inferSelect;

/** Keep model replacement and its lifecycle records in the input's statement. */
function modelReplacementCtes(replacement: ThreadModelReplacement | null) {
  if (!replacement) {
    return sql.empty();
  }
  const tierChanged =
    replacement.codexServiceTier !== replacement.replacedCodexServiceTier;
  const count = tierChanged ? 2 : 1;
  const tierUpdate = tierChanged
    ? sql`, codex_service_tier=${replacement.codexServiceTier}`
    : sql.empty();
  return sql`, replaced_model AS (
    UPDATE chat_threads SET selected_model=${replacement.selectedModel},updated_at=timezone('UTC',now()) ${tierUpdate}
    WHERE id=${replacement.chatThreadId}::uuid AND user_id=${replacement.userId}
      AND selected_model=${replacement.replacedModel} AND EXISTS(SELECT 1 FROM inserted)
    RETURNING id
  ), replacement_positions AS (
    INSERT INTO chat_thread_event_sequences(user_id,org_id,last_seq_id)
    SELECT ${replacement.userId},${replacement.orgId},${count} FROM replaced_model
    ON CONFLICT(user_id,org_id) DO UPDATE SET last_seq_id=chat_thread_event_sequences.last_seq_id+EXCLUDED.last_seq_id
    RETURNING last_seq_id
  ), replacement_events AS (
    INSERT INTO chat_thread_events(user_id,org_id,seq_id,chat_thread_id,kind,agent_id,selected_model,service_tier)
    SELECT ${replacement.userId},${replacement.orgId},last_seq_id-${count}+ordinal,${replacement.chatThreadId}::uuid,
      kind::chat_thread_event_kind,${replacement.agentId}::uuid,
      CASE WHEN ordinal=1 THEN ${replacement.selectedModel} ELSE NULL END,
      CASE WHEN ordinal=2 THEN ${chatThreadServiceTierFromCodex(replacement.codexServiceTier)} ELSE NULL END
    FROM replacement_positions CROSS JOIN (VALUES (1,'model_selection_updated'),(2,'service_tier_updated')) AS changes(ordinal,kind)
    WHERE ordinal<=${count}
    RETURNING id
  )`;
}
export function wechatEventId(
  connectionId: string,
  generation: string,
  messageId: string,
) {
  const hex = createHash("sha256")
    .update(JSON.stringify(["wechat", connectionId, generation, messageId]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const ensureThread$ = command(
  async ({ set }, connection: Connection, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [existing] = await db
      .select({ chatThreadId: wechatChatThreadRoutes.chatThreadId })
      .from(wechatChatThreadRoutes)
      .where(eq(wechatChatThreadRoutes.connectionId, connection.id))
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      return existing.chatThreadId;
    }
    const [agent] = await db
      .select({ id: agents.id })
      .from(orgMetadata)
      .innerJoin(
        agents,
        and(
          eq(agents.id, orgMetadata.defaultAgentId),
          eq(agents.orgId, orgMetadata.orgId),
        ),
      )
      .where(eq(orgMetadata.orgId, connection.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (!agent) {
      throw new Error("WeChat workspace has no default agent");
    }
    const owner = { orgId: connection.orgId, userId: connection.userId };
    const initialModel = await set(
      resolveDefaultModelFirstPin$,
      { ...owner, orgPlanCapabilities: undefined },
      signal,
    );
    const defaults = await set(loadNewChatThreadDefaults$, owner, signal);
    const thread = integrationChatThreadValues(
      { ...owner, agentId: agent.id, currentTime: nowDate(), initialModel },
      randomUUID(),
      defaults,
    );
    const routeInsert = db
      .insert(wechatChatThreadRoutes)
      .values({ connectionId: connection.id, chatThreadId: thread.id })
      .onConflictDoNothing({ target: wechatChatThreadRoutes.connectionId })
      .returning({ chatThreadId: wechatChatThreadRoutes.chatThreadId });
    const route = db.$with("wechat_route").as(routeInsert);
    const threadInsert = sql`${integrationChatThreadInsertFromRouteSql(thread, route)} RETURNING ${chatThreads.agentId}`;
    const [inserted] = parseRawRows(
      z.object({ chatThreadId: z.uuid() }),
      await db.execute(
        integrationThreadCreatedEventSql(connection.orgId, thread, {
          cte: sql`wechat_route AS (${routeInsert.getSQL()}), wechat_thread AS (${threadInsert})`,
          gate: sql`EXISTS(SELECT 1 FROM wechat_thread)`,
          agentId: sql`(SELECT agent_id FROM wechat_thread)`,
          result: sql`SELECT chat_thread_id AS "chatThreadId" FROM wechat_route WHERE EXISTS(SELECT 1 FROM inserted)`,
        }),
      ),
    );
    signal.throwIfAborted();
    if (inserted) {
      return inserted.chatThreadId;
    }
    const [winner] = await db
      .select({ chatThreadId: wechatChatThreadRoutes.chatThreadId })
      .from(wechatChatThreadRoutes)
      .where(eq(wechatChatThreadRoutes.connectionId, connection.id))
      .limit(1);
    signal.throwIfAborted();
    if (!winner) {
      throw new Error("WeChat route publication did not succeed");
    }
    return winner.chatThreadId;
  },
);
function wechatMessagePrompt(message: WechatMessage) {
  const text = (message.item_list ?? [])
    .filter((item) => {
      return item.type === 1;
    })
    .map((item) => {
      return item.text_item?.text ?? "";
    })
    .join("\n");
  const unsupported = (message.item_list ?? []).some((item) => {
    return item.type !== 1;
  });
  return [
    text,
    ...(unsupported
      ? [
          "[The sender included an attachment. This WeChat connection supports text only; explain that it was not read and ask for the content as text.]",
        ]
      : []),
  ]
    .join("\n")
    .trim();
}
export const receiveWechatMessage$ = command(
  async (
    { set },
    args: { readonly connection: Connection; readonly message: WechatMessage },
    signal: AbortSignal,
  ) => {
    const { connection, message } = args;
    // Only the verified scanner's direct messages can become an Okou input.
    if (
      message.message_type !== 1 ||
      message.from_user_id !== connection.senderId ||
      message.group_id ||
      (message.to_user_id && message.to_user_id !== connection.botId) ||
      !message.context_token
    ) {
      return;
    }
    const prompt = wechatMessagePrompt(message);
    if (!prompt) {
      return;
    }
    const threadId = await set(ensureThread$, connection, signal);

    const model = await set(
      resolveEnqueuedChatInputModel$,
      { threadId, orgId: connection.orgId, userId: connection.userId },
      signal,
    );

    const id = wechatEventId(
      connection.id,
      connection.generation,
      message.message_id,
    );
    const quotedText =
      (message.item_list ?? [])
        .map((item) => {
          return (
            item.ref_msg?.message_item?.text_item?.text ??
            item.ref_msg?.title ??
            ""
          );
        })
        .filter(Boolean)
        .join("\n")
        .slice(0, 12_000) || null;
    const context = {
      connectionId: connection.id,
      generation: connection.generation,
      senderId: connection.senderId,
      botId: connection.botId,
      messageId: message.message_id,
      contextTokenCiphertext: await encryptStoredSecretValue(
        message.context_token,
      ),
      quotedText,
    };
    const currentTime = nowDate();
    const prepared = prepareChatEvent({
      id,
      chatThreadId: threadId,
      eventType: "input.prompt",
      runId: null,
      modelSelection: model.modelSelection,
      userMessage: createUserMessageDocument({
        text: prompt,
        nonContentPart: { type: "source", kind: "wechat" },
      }),
      wechatContext: context,
      createdAt: currentTime,
    });
    const db = set(writeDb$);
    // Context, receipt (the deterministic canonical event ID), and queue commit
    // together. Replays do not enqueue again; a concurrent disconnect fails closed.
    const contextInsert = db
      .insert(chatWechatContext)
      .values({
        ...context,
        id,
        chatThreadId: threadId,
        createdAt: currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: chatWechatContext.id });
    // Queue compare-and-delete uses JS Dates; preserve millisecond precision.
    const inserted = parseRawRows(
      z.object({ id: z.uuid() }),
      await db.execute(sql`WITH context_insert AS (${contextInsert.getSQL()}), ${canonicalChatEventAppendCtes([prepared.row], "id", sql`EXISTS(SELECT 1 FROM ${wechatConnections} WHERE id=${connection.id}::uuid AND generation=${connection.generation}::uuid AND status='active') AND EXISTS(SELECT 1 FROM context_insert)`)}
 ${modelReplacementCtes(model.threadModelReplacement)}, enqueued AS (
 INSERT INTO queued_chat_threads (chat_thread_id,org_id,queued_at)
 SELECT ${threadId}::uuid,${connection.orgId},${sql.param(currentTime, queuedChatThreads.queuedAt)} FROM inserted
 ${model.threadModelReplacement ? sql`WHERE (SELECT count(*) FROM replacement_events)>=0` : sql.empty()}
 ON CONFLICT(chat_thread_id) DO UPDATE SET queued_at=greatest(EXCLUDED.queued_at,queued_chat_threads.queued_at+interval '1 millisecond') RETURNING chat_thread_id)
 SELECT id FROM inserted WHERE EXISTS(SELECT 1 FROM enqueued)`),
    );
    signal.throwIfAborted();
    if (inserted.length > 0) {
      await set(
        touchNativeChatThread$,
        {
          chatThreadId: threadId,
          createdAt: currentTime,
          eventId: id,
          authorizedScope: {
            orgId: connection.orgId,
            userId: connection.userId,
          },
        },
        signal,
      );
      await publishThreadListChangedSafely({
        orgId: connection.orgId,
        userId: connection.userId,
      });
      signal.throwIfAborted();
      await publishChatThreadMessageCreatedSafely({
        orgId: connection.orgId,
        userId: connection.userId,
        threadId,
      });
      signal.throwIfAborted();
    }

    await set(notifyRunningChatRunOfPendingInput$, threadId, signal);

    await set(
      pickEnqueuedChatThread$,
      { orgId: connection.orgId, chatThreadId: threadId },
      signal,
    );
  },
);
