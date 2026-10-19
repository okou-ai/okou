import { wechatAttachments } from "../external/wechat-media";
import { MAX_WECHAT_FILE_SIZE_BYTES } from "@okouai/api-contracts/contracts/integrations-wechat-files";
import {
  materializeIntegrationInputAssets$,
  integrationInputMessageFiles,
  type IntegrationInputFile,
} from "./integration-input-assets.service";
import { isWechatOwnerMessage, wechatEventId } from "./wechat-message-identity";
import { queuedChatThreads } from "@okouai/db/schema/queued-chat-thread";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChangedSafely,
} from "../external/realtime";
import { touchNativeChatThread$ } from "./native-chat-event-write.service";
import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  wechatConnections,
  wechatChatThreadRoutes,
  chatWechatContext,
  wechatMessages,
} from "@okouai/db/schema/wechat";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { agents } from "@okouai/db/schema/agent";
import { writeDb$ } from "../external/db";
import { waitUntil } from "../context/wait-until";
import { reconcileWechatThreadTyping$ } from "./wechat-thread-typing.service";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { monotonicNow, nowDate } from "../../lib/time";
import { recordWechatMessageReceived } from "./wechat-delivery-timing.service";
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
import {
  createUserMessageDocument,
  projectUserMessage,
} from "./chat-user-message.service";
import { prepareChatEvent } from "./chat-event.service";
import { canonicalChatEventAppendCtes } from "./chat-event-append.service";
import { encryptStoredSecretValue } from "./crypto.utils";
import {
  pickEnqueuedChatThread$,
  notifyRunningChatRunOfPendingInput$,
} from "./chat-thread-queue-drain.service";

type Connection = typeof wechatConnections.$inferSelect;

export class WechatIngressError extends Error {
  constructor(
    readonly reason: "default_agent_unavailable" | "attachment_unavailable",
    readonly retryable: boolean,
  ) {
    super(`WeChat input unavailable: ${reason}`);
    this.name = "WechatIngressError";
  }
}

function activeBinding(connection: Connection) {
  return and(
    eq(wechatConnections.id, connection.id),
    eq(wechatConnections.generation, connection.generation),
    eq(wechatConnections.status, "active"),
  );
}

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
const ensureThread$ = command(
  async ({ set }, connection: Connection, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [existing] = await db
      .select({ chatThreadId: wechatChatThreadRoutes.chatThreadId })
      .from(wechatConnections)
      .leftJoin(
        wechatChatThreadRoutes,
        eq(wechatChatThreadRoutes.connectionId, wechatConnections.id),
      )
      .where(activeBinding(connection))
      .limit(1);
    signal.throwIfAborted();
    if (!existing) {
      return;
    }
    if (existing.chatThreadId) {
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
      throw new WechatIngressError("default_agent_unavailable", false);
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
      .select(
        db
          .select({
            id: sql`gen_random_uuid()`
              .mapWith(wechatChatThreadRoutes.id)
              .as("id"),
            connectionId: wechatConnections.id,
            chatThreadId: sql`${thread.id}::uuid`
              .mapWith(wechatChatThreadRoutes.chatThreadId)
              .as("chat_thread_id"),
            createdAt: sql`now()`
              .mapWith(wechatChatThreadRoutes.createdAt)
              .as("created_at"),
          })
          .from(wechatConnections)
          .where(activeBinding(connection)),
      )
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
      .from(wechatConnections)
      .leftJoin(
        wechatChatThreadRoutes,
        eq(wechatChatThreadRoutes.connectionId, wechatConnections.id),
      )
      .where(activeBinding(connection))
      .limit(1);
    signal.throwIfAborted();
    if (!winner) {
      return;
    }
    if (!winner.chatThreadId) {
      throw new Error("WeChat route publication did not succeed");
    }
    return winner.chatThreadId;
  },
);
function wechatMessagePrompt(message: WechatMessage) {
  const text = (message.item_list ?? [])
    .filter((item) => {
      return item.type === 1 || item.type === 3;
    })
    .map((item) => {
      return item.text_item?.text ?? item.voice_item?.text ?? "";
    })
    .join("\n");
  const attachments = wechatAttachments(message.item_list ?? []);
  const unsupported = (message.item_list ?? []).some((item, index) => {
    return (
      item.type !== 1 &&
      !item.voice_item?.text &&
      !attachments.some((file) => {
        return file.id === String(index);
      })
    );
  });
  return [
    text,
    ...(unsupported
      ? [
          "[The sender included an attachment. This item could not be retrieved; explain that it was not read and ask the sender to resend it as a supported file or text.]",
        ]
      : []),
  ]
    .join("\n")
    .trim();
}
function quotedWechatText(message: WechatMessage) {
  return (
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
      .slice(0, 12_000) || null
  );
}
const materializeWechatUserMessage$ = command(
  async (
    { set },
    args: {
      readonly connection: Connection;
      readonly message: WechatMessage;
      readonly chatThreadId: string;
      readonly eventId: string;
      readonly text: string;
    },
    signal: AbortSignal,
  ) => {
    const { connection, message } = args;
    const files: IntegrationInputFile[] = wechatAttachments(
      message.item_list ?? [],
    ).map((attachment) => {
      const item = message.item_list?.[Number(attachment.id)];
      if (!item) {
        throw new Error("WeChat attachment has no provider item");
      }
      return {
        sourceId: attachment.id,
        filename: attachment.filename,
        size: attachment.size ?? undefined,
        maxBytes: MAX_WECHAT_FILE_SIZE_BYTES,
        provenance: {
          provider: "wechat",
          installationId: connection.id,
          messageId: message.message_id,
          externalFileId: `${args.eventId}:${attachment.id}`,
        },
        resource: { provider: "wechat", item },
      };
    });
    const assets = await set(
      materializeIntegrationInputAssets$,
      {
        userId: connection.userId,
        orgId: connection.orgId,
        chatThreadId: args.chatThreadId,
        files,
      },
      signal,
    );
    signal.throwIfAborted();
    if (
      assets.some(({ asset }) => {
        return asset.error?.retryable;
      })
    ) {
      // Keep the durable provider batch until a transient import can be retried.
      throw new WechatIngressError("attachment_unavailable", true);
    }
    return createUserMessageDocument({
      text: args.text,
      files: integrationInputMessageFiles(assets),
      nonContentPart: { type: "source", kind: "wechat" },
    });
  },
);

async function wechatMessageMaterial(
  connection: Connection,
  message: WechatMessage,
  contextToken: string,
) {
  const attachments = wechatAttachments(message.item_list ?? []);
  return {
    context: {
      connectionId: connection.id,
      generation: connection.generation,
      senderId: connection.senderId,
      botId: connection.botId,
      messageId: message.message_id,
      contextTokenCiphertext: await encryptStoredSecretValue(contextToken),
      quotedText: quotedWechatText(message),
    },
    attachments,
    mediaCiphertext: attachments.length
      ? await encryptStoredSecretValue(JSON.stringify(message.item_list))
      : null,
  };
}

export const receiveWechatMessage$ = command(
  async (
    { set },
    args: { readonly connection: Connection; readonly message: WechatMessage },
    signal: AbortSignal,
  ) => {
    const { connection, message } = args;
    // Only the verified scanner's direct messages can become an Okou input.
    // A provider can redeliver an old long-poll batch after reconnection. Only
    // messages demonstrably created after consent belong to this new binding.
    if (
      connection.status !== "active" ||
      !isWechatOwnerMessage(connection, message) ||
      (connection.resumedAt !== null &&
        (message.create_time_ms === undefined ||
          message.create_time_ms <= connection.resumedAt.getTime()))
    ) {
      return;
    }
    const id = wechatEventId(
      connection.id,
      connection.generation,
      message.message_id,
    );
    const receivedAt = nowDate().toISOString();
    const receivedStartedAt = monotonicNow();
    const { context, attachments, mediaCiphertext } =
      await wechatMessageMaterial(connection, message, message.context_token);
    signal.throwIfAborted();
    const text = wechatMessagePrompt(message);
    if (!text && attachments.length === 0) {
      return;
    }
    const threadId = await set(ensureThread$, connection, signal);
    if (!threadId) {
      return;
    }
    const userMessage = await set(
      materializeWechatUserMessage$,
      { connection, message, chatThreadId: threadId, eventId: id, text },
      signal,
    );
    signal.throwIfAborted();
    const prompt = projectUserMessage(userMessage).agentPrompt;

    const model = await set(
      resolveEnqueuedChatInputModel$,
      { threadId, orgId: connection.orgId, userId: connection.userId },
      signal,
    );

    const currentTime = nowDate();
    const prepared = prepareChatEvent({
      id,
      chatThreadId: threadId,
      eventType: "input.prompt",
      runId: null,
      modelSelection: model.modelSelection,
      userMessage,
      wechatContext: context,
      createdAt: currentTime,
    });
    const db = set(writeDb$);
    // Context, receipt (the deterministic canonical event ID), and queue commit
    // together. Replays do not enqueue again; a concurrent disconnect fails closed.
    const contextInsert = sql`INSERT INTO chat_wechat_context
      (id,chat_thread_id,connection_id,generation,sender_id,bot_id,message_id,context_token_ciphertext,quoted_text,created_at)
      SELECT ${id}::uuid,${threadId}::uuid,id,generation,sender_id,bot_id,${message.message_id},${context.contextTokenCiphertext},${context.quotedText},${sql.param(currentTime, chatWechatContext.createdAt)}
      FROM ${wechatConnections} WHERE ${activeBinding(connection)}
      ON CONFLICT DO NOTHING RETURNING id`;
    // Queue compare-and-delete uses JS Dates; preserve millisecond precision.
    const inserted = parseRawRows(
      z.object({ id: z.uuid() }),
      await db.execute(sql`WITH context_insert AS (${contextInsert}), ${canonicalChatEventAppendCtes([prepared.row], "id", sql`EXISTS(SELECT 1 FROM ${wechatConnections} WHERE ${activeBinding(connection)}) AND EXISTS(SELECT 1 FROM context_insert)`)}
 ${modelReplacementCtes(model.threadModelReplacement)}, archived AS (
 INSERT INTO wechat_messages(id,connection_id,generation,provider_message_id,direction,status,content,quoted_text,attachments,media_ciphertext,created_at)
 SELECT ${id}::uuid,${connection.id}::uuid,${connection.generation}::uuid,${message.message_id},'inbound','received',${prompt},${context.quotedText},${sql.param(attachments, wechatMessages.attachments)},${mediaCiphertext},${sql.param(currentTime, wechatMessages.createdAt)} FROM inserted
 ON CONFLICT DO NOTHING RETURNING id
 ), enqueued AS (
 INSERT INTO queued_chat_threads (chat_thread_id,org_id,queued_at)
 SELECT ${threadId}::uuid,${connection.orgId},${sql.param(currentTime, queuedChatThreads.queuedAt)} FROM inserted
 WHERE EXISTS(SELECT 1 FROM archived) ${model.threadModelReplacement ? sql`AND (SELECT count(*) FROM replacement_events)>=0` : sql.empty()}
 ON CONFLICT(chat_thread_id) DO UPDATE SET queued_at=greatest(EXCLUDED.queued_at,queued_chat_threads.queued_at+interval '1 millisecond') RETURNING chat_thread_id)
 SELECT id FROM inserted WHERE EXISTS(SELECT 1 FROM enqueued)`),
    );
    signal.throwIfAborted();
    if (inserted.length > 0) {
      recordWechatMessageReceived(id, threadId, receivedAt, receivedStartedAt);
      waitUntil(
        set(
          reconcileWechatThreadTyping$,
          {
            chatThreadId: threadId,
            target: {
              connectionId: connection.id,
              generation: connection.generation,
              senderId: connection.senderId,
              messageId: message.message_id,
              contextId: id,
            },
          },
          new AbortController().signal,
        ),
      );
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
