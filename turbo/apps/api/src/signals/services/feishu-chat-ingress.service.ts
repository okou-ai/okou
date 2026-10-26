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
import {
  int,
  object,
  string,
  union,
  uuid,
  enum as zEnum,
  null as zNull,
} from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
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

const ROUTE_COLUMNS = {
  id: feishuChatThreadRoutes.id,
  connectionId: feishuChatThreadRoutes.connectionId,
  chatId: feishuChatThreadRoutes.chatId,
  threadId: feishuChatThreadRoutes.threadId,
  userId: feishuChatThreadRoutes.userId,
  chatThreadId: feishuChatThreadRoutes.chatThreadId,
} as const;

const routeResultSchema = object({
  id: uuid(),
  connectionId: uuid(),
  chatId: string(),
  threadId: string(),
  userId: string(),
  chatThreadId: uuid(),
});

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
    let [route] = await db
      .select(ROUTE_COLUMNS)
      .from(feishuChatThreadRoutes)
      .where(routeWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const routeInsert = db
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
      const insertedRoute = db.$with("inserted_feishu_route").as(routeInsert);
      // The event and sequence must consume the actual inserted thread, since
      // the statement snapshot cannot read a new row from the base table.
      const insertedThread = sql`${integrationChatThreadInsertFromRouteSql(thread, insertedRoute)} RETURNING agent_id`;
      const [inserted] = parseRawRows(
        routeResultSchema,
        await db.execute(
          integrationThreadCreatedEventSql(args.orgId, thread, {
            cte: sql`inserted_feishu_route AS (${routeInsert.getSQL()}),
            inserted_feishu_thread AS (${insertedThread})`,
            gate: sql`EXISTS (SELECT 1 FROM inserted_feishu_thread)`,
            agentId: sql`(SELECT agent_id FROM inserted_feishu_thread)`,
            result: sql`SELECT id, connection_id AS "connectionId",
            chat_id AS "chatId", thread_id AS "threadId", user_id AS "userId",
            chat_thread_id AS "chatThreadId" FROM inserted_feishu_route`,
          }),
        ),
      );
      signal.throwIfAborted();
      if (inserted) {
        return inserted;
      }
      // ON CONFLICT waited for the winner's commit; use a new statement
      // snapshot to read it once, preserving the unjoined route lookup.
      [route] = await db
        .select(ROUTE_COLUMNS)
        .from(feishuChatThreadRoutes)
        .where(routeWhere(args))
        .limit(1);
      if (signal.aborted) {
        // Preserve the original missing-winner error before cancellation.
        if (route) {
          signal.throwIfAborted();
        }
      }
      if (!route) {
        throw new Error(
          "Failed to resolve Feishu chat thread route after conflict",
        );
      }
    }
    // Both an existing route and a fresh winner follow the latest DM chat
    // through the original conditional update pinned to id and route key.
    if (
      args.threadId === INTEGRATION_DM_SESSION_KEY &&
      route.chatId !== args.chatId
    ) {
      const [updated] = await db
        .update(feishuChatThreadRoutes)
        .set({ chatId: args.chatId })
        .where(and(eq(feishuChatThreadRoutes.id, route.id), routeWhere(args)))
        .returning({ chatId: feishuChatThreadRoutes.chatId });
      if (signal.aborted) {
        // Preserve the original zero-update error before cancellation.
        if (updated) {
          signal.throwIfAborted();
        }
      }
      if (!updated) {
        throw new Error("Failed to update Feishu DM route destination");
      }
      route = { ...route, ...updated };
    }
    signal.throwIfAborted();
    return route;
  },
);

interface FeishuChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: FeishuChatIngressStatus;
  readonly retryCount: number;
}

const ingressInsertResultSchema = union([
  object({
    id: uuid(),
    status: zEnum(["pending", "processing", "processed", "failed"]),
    retryCount: int().nonnegative(),
  }),
  object({ id: zNull(), status: zNull(), retryCount: zNull() }),
]);

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
    // A committed implicit statement cannot be rolled back by a later Abort.
    // Avoid starting it for an already cancelled admission.
    signal.throwIfAborted();
    const receiptInsert = db
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
    // Drizzle INSERT SELECT requires every table column. Keep database UUID
    // and retry-count defaults by naming only the original supplied columns.
    // Both writes consume actual RETURNING; a child SQL error rolls both back.
    const [inserted] = parseRawRows(
      ingressInsertResultSchema,
      await db.execute(sql`WITH inserted_feishu_receipt AS (${receiptInsert.getSQL()}),
        inserted_feishu_ingress AS (
          INSERT INTO ${feishuChatIngress}
            (installation_id, event_id, payload, status, created_at, updated_at)
          SELECT ${sql.param(args.installationId, feishuChatIngress.installationId)},
            ${sql.param(args.eventId, feishuChatIngress.eventId)},
            ${sql.param(args.payload, feishuChatIngress.payload)},
            ${sql.param("pending", feishuChatIngress.status)},
            ${sql.param(args.currentTime, feishuChatIngress.createdAt)},
            ${sql.param(args.currentTime, feishuChatIngress.updatedAt)}
          FROM inserted_feishu_receipt
          RETURNING id, status, retry_count AS "retryCount"
        )
        SELECT ingress.id, ingress.status, ingress."retryCount"
        FROM inserted_feishu_receipt
        LEFT JOIN inserted_feishu_ingress AS ingress ON TRUE`),
    );
    signal.throwIfAborted();
    if (inserted) {
      if (inserted.id === null) {
        throw new Error("Failed to persist Feishu ingress event");
      }
      return { ...inserted, inserted: true };
    }

    // A conflict may wait for a concurrent receipt winner. Read its committed
    // ingress with one fresh statement snapshot, including legacy absence.
    const [existing] = await db
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
    const [retried] = await db
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
    signal.throwIfAborted();
    return { ...retried, inserted: false };
  },
);
