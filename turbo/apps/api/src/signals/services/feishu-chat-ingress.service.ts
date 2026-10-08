import {
  feishuChatIngress,
  type FeishuChatIngressStatus,
} from "@okouai/db/schema/feishu-chat-ingress";
import { feishuOrgEvents } from "@okouai/db/schema/feishu-org-event";
import type { FeishuInboundMessage } from "./feishu-dispatch.service";
import { INTEGRATION_DM_SESSION_KEY } from "../../lib/integration-dm-session";
import { feishuChatThreadRoutes } from "@okouai/db/schema/feishu-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import type { Tx } from "../../lib/db-types";
import {
  integrationChatThreadInsertFromRouteSql,
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

type FeishuChatThreadRouteRow = FeishuChatThreadRouteBinding;

async function loadFeishuChatThreadRoute(
  tx: Tx,
  key: FeishuChatThreadRouteKey,
): Promise<FeishuChatThreadRouteRow | undefined> {
  const [route] = await tx
    .select(ROUTE_COLUMNS)
    .from(feishuChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
  return route;
}

/** A DM route follows the latest chat through one conditional update. */
async function adoptFeishuChatThreadRoute(
  tx: Tx,
  existing: FeishuChatThreadRouteRow,
  key: FeishuChatThreadRouteKey,
): Promise<FeishuChatThreadRouteBinding> {
  if (
    key.threadId !== INTEGRATION_DM_SESSION_KEY ||
    existing.chatId === key.chatId
  ) {
    return existing;
  }
  const [updated] = await tx
    .update(feishuChatThreadRoutes)
    .set({ chatId: key.chatId })
    .where(and(eq(feishuChatThreadRoutes.id, existing.id), routeWhere(key)))
    .returning({ chatId: feishuChatThreadRoutes.chatId });
  if (!updated) {
    throw new Error("Failed to update Feishu DM route destination");
  }
  return { ...existing, ...updated };
}

/**
 * The unique route and its new thread/event commit in this command alone.
 * One `INSERT … ON CONFLICT DO NOTHING` decides a concurrent create; the loser
 * reads the committed winner once. The thread row is inserted by the same
 * statement only when the route insert wins.
 */
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
      const existing = await loadFeishuChatThreadRoute(tx, args);
      if (existing) {
        return await adoptFeishuChatThreadRoute(tx, existing, args);
      }
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insertedRoute = tx.$with("inserted_feishu_route").as(
        tx
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
          .returning(ROUTE_COLUMNS),
      );
      const insertedThread = tx
        .$with("inserted_feishu_thread", {})
        .as(integrationChatThreadInsertFromRouteSql(thread, insertedRoute));
      const [route] = await tx
        .with(insertedRoute, insertedThread)
        .select()
        .from(insertedRoute);
      if (route) {
        await tx.execute(integrationThreadCreatedEventSql(args.orgId, thread));
        signal.throwIfAborted();
        return route;
      }
      // ON CONFLICT waited for the winner's commit; read it once.
      const winner = await loadFeishuChatThreadRoute(tx, args);
      if (!winner) {
        throw new Error(
          "Failed to resolve Feishu chat thread route after conflict",
        );
      }
      return await adoptFeishuChatThreadRoute(tx, winner, args);
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

export const admitFeishuChatEvent$ = command(
  async (
    { set },
    args: {
      readonly installationId: string;
      readonly eventId: string;
      readonly payload: string;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<FeishuChatIngressAdmission | null> => {
    const db = set(writeDb$);
    const result = await db.transaction(async (tx) => {
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
      signal.throwIfAborted();

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
        signal.throwIfAborted();
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
      signal.throwIfAborted();
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
      signal.throwIfAborted();
      if (!retried) {
        throw new Error("Failed to record Feishu ingress retry");
      }
      return { ...retried, inserted: false };
    });
    signal.throwIfAborted();
    return result;
  },
);
