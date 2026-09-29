import {
  feishuChatIngress,
  type FeishuChatIngressStatus,
} from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgEvents } from "@okouai/db/schema/feishu-org-event";
import type { FeishuInboundMessage } from "./feishu-dispatch.service";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadValues,
  integrationThreadCreatedEventSql,
  type IntegrationChatThreadCreation,
} from "./integration-chat-thread-publication";

interface FeishuChatThreadRouteKey {
  readonly connectionId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly userId: string;
}

interface FeishuChatThreadRouteBinding extends FeishuChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

function routeWhere(key: FeishuChatThreadRouteKey) {
  return and(
    eq(feishuChatThreadRoutes.connectionId, key.connectionId),
    key.threadId === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(feishuChatThreadRoutes.chatId, key.chatId),
    eq(feishuChatThreadRoutes.threadId, key.threadId),
    eq(feishuChatThreadRoutes.userId, key.userId),
  );
}

/** Route key of the conversation a Feishu message belongs to. */
export function feishuRouteThreadId(
  message: Pick<
    FeishuInboundMessage,
    "chatType" | "rootId" | "threadId" | "parentId" | "messageId"
  >,
): string {
  const replyThreadId =
    message.rootId ?? message.threadId ?? message.parentId ?? null;
  if (message.chatType === "p2p") {
    if (message.threadId) {
      return `thread:${message.threadId}`;
    }
    return INTEGRATION_DM_SESSION_KEY;
  }
  return replyThreadId ?? message.messageId;
}

/** Read the chat thread a Feishu conversation already routes to. */
export const findFeishuRoutedChatThreadId$ = command(
  async (
    { set },
    key: FeishuChatThreadRouteKey,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({ chatThreadId: feishuChatThreadRoutes.chatThreadId })
      .from(feishuChatThreadRoutes)
      .where(routeWhere(key))
      .limit(1);
    signal?.throwIfAborted();
    return route?.chatThreadId;
  },
);

const ROUTE_COLUMNS = {
  id: feishuChatThreadRoutes.id,
  connectionId: feishuChatThreadRoutes.connectionId,
  chatId: feishuChatThreadRoutes.chatId,
  threadId: feishuChatThreadRoutes.threadId,
  userId: feishuChatThreadRoutes.userId,
  chatThreadId: feishuChatThreadRoutes.chatThreadId,
} as const;

/** The unique route and its new thread/event commit in this command alone. */
export const ensureFeishuChatThreadRoute$ = command(
  async (
    { set },
    args: FeishuChatThreadRouteKey & IntegrationChatThreadCreation,
    signal: AbortSignal,
  ): Promise<FeishuChatThreadRouteBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const candidateId = randomUUID();
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const [existing] = await tx
          .select(ROUTE_COLUMNS)
          .from(feishuChatThreadRoutes)
          .where(routeWhere(args))
          .limit(1);
        if (existing) {
          if (
            args.threadId === INTEGRATION_DM_SESSION_KEY &&
            existing.chatId !== args.chatId
          ) {
            const [updated] = await tx
              .update(feishuChatThreadRoutes)
              .set({ chatId: args.chatId })
              .where(
                and(
                  eq(feishuChatThreadRoutes.id, existing.id),
                  routeWhere(args),
                ),
              )
              .returning({
                chatId: feishuChatThreadRoutes.chatId,
              });
            if (!updated) {
              throw new Error("Failed to update Feishu DM route destination");
            }
            return { ...existing, ...updated };
          }
          return existing;
        }
        if (attempt === 1) {
          break;
        }
        const thread = integrationChatThreadValues(args, candidateId, defaults);
        await tx.insert(chatThreads).values(thread);
        const [route] = await tx
          .insert(feishuChatThreadRoutes)
          .values({
            connectionId: args.connectionId,
            chatId: args.chatId,
            threadId: args.threadId,
            userId: args.userId,
            chatThreadId: thread.id,
            createdAt: args.currentTime,
          })
          .onConflictDoNothing({
            target: [
              feishuChatThreadRoutes.connectionId,
              feishuChatThreadRoutes.chatId,
              feishuChatThreadRoutes.threadId,
              feishuChatThreadRoutes.userId,
            ],
          })
          .returning(ROUTE_COLUMNS);
        if (route) {
          await tx.execute(
            integrationThreadCreatedEventSql(args.orgId, thread),
          );
          signal.throwIfAborted();
          return route;
        }
        await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      }
      throw new Error(
        "Failed to resolve Feishu chat thread route after conflict",
      );
    });
    signal.throwIfAborted();
    return result;
  },
);

interface FeishuChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: FeishuChatIngressStatus;
  readonly retryCount: number;
}

export async function admitFeishuChatEvent(
  db: Db,
  args: {
    readonly installationId: string;
    readonly eventId: string;
    readonly payload: string;
    readonly currentTime: Date;
  },
): Promise<FeishuChatIngressAdmission | null> {
  return await db.transaction(async (tx) => {
    const [receipt] = await tx
      .insert(feishuOrgEvents)
      .values({
        installationId: args.installationId,
        eventId: args.eventId,
        receivedAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [feishuOrgEvents.installationId, feishuOrgEvents.eventId],
      })
      .returning({ eventId: feishuOrgEvents.eventId });

    if (receipt) {
      const [inserted] = await tx
        .insert(feishuChatIngress)
        .values({
          installationId: args.installationId,
          eventId: args.eventId,
          payload: args.payload,
          status: "pending",
          createdAt: args.currentTime,
          updatedAt: args.currentTime,
        })
        .returning({
          id: feishuChatIngress.id,
          status: feishuChatIngress.status,
          retryCount: feishuChatIngress.retryCount,
        });
      if (!inserted) {
        throw new Error("Failed to persist Feishu ingress event");
      }
      return { ...inserted, inserted: true };
    }

    const [existing] = await tx
      .select({
        id: feishuChatIngress.id,
        status: feishuChatIngress.status,
        retryCount: feishuChatIngress.retryCount,
      })
      .from(feishuChatIngress)
      .where(
        and(
          eq(feishuChatIngress.installationId, args.installationId),
          eq(feishuChatIngress.eventId, args.eventId),
        ),
      )
      .limit(1);
    if (!existing) {
      return null;
    }
    const [retried] = await tx
      .update(feishuChatIngress)
      .set({
        retryCount: sql`${feishuChatIngress.retryCount} + 1`,
        updatedAt: args.currentTime,
      })
      .where(eq(feishuChatIngress.id, existing.id))
      .returning({
        id: feishuChatIngress.id,
        status: feishuChatIngress.status,
        retryCount: feishuChatIngress.retryCount,
      });
    if (!retried) {
      throw new Error("Failed to record Feishu ingress retry");
    }
    return { ...retried, inserted: false };
  });
}
