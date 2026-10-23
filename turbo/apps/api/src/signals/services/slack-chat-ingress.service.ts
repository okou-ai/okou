import {
  slackChatIngress,
  type SlackChatIngressStatus,
} from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq, exists, sql } from "drizzle-orm";
import * as z from "zod";

import { db$, writeDb$ } from "../external/db";
import { parseRawRows } from "../../lib/db-raw-rows";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
  integrationChatThreadInsertFromRouteSql,
  integrationChatThreadValues,
  integrationThreadCreatedEventSql,
  type IntegrationChatThreadCreation,
} from "./integration-chat-thread-publication";
import {
  INTEGRATION_DM_SESSION_KEY,
  isIntegrationDmSessionKey,
} from "../../lib/integration-dm-session";

interface SlackChatThreadRouteKey {
  readonly connectionId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly userId: string;
}

interface SlackChatThreadRouteBinding extends SlackChatThreadRouteKey {
  readonly id: string;
  readonly chatThreadId: string;
}

export function slackSessionThreadTs(args: {
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly messageTs: string;
  readonly threadTs?: string;
}): string {
  if (args.channelType === "dm" && !args.threadTs) {
    return INTEGRATION_DM_SESSION_KEY;
  }
  return args.threadTs ?? args.messageTs;
}

export function isSlackDirectMessageSessionThreadTs(threadTs: string): boolean {
  return isIntegrationDmSessionKey(threadTs);
}

function slackChatThreadRouteWhere(key: SlackChatThreadRouteKey) {
  return and(
    eq(slackChatThreadRoutes.connectionId, key.connectionId),
    key.threadTs === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(slackChatThreadRoutes.channelId, key.channelId),
    eq(slackChatThreadRoutes.threadTs, key.threadTs),
    eq(slackChatThreadRoutes.userId, key.userId),
  );
}

/** Read the route and update its direct-message destination in this command. */
export const findSlackChatThreadRoute$ = command(
  async (
    { get, set },
    key: SlackChatThreadRouteKey,
    signal: AbortSignal,
  ): Promise<SlackChatThreadRouteBinding | undefined> => {
    const db = get(db$);
    const [route] = await db
      .select(ROUTE_COLUMNS)
      .from(slackChatThreadRoutes)
      .where(slackChatThreadRouteWhere(key))
      .limit(1);
    signal.throwIfAborted();
    if (
      route &&
      key.threadTs === INTEGRATION_DM_SESSION_KEY &&
      route.channelId !== key.channelId
    ) {
      const writeDb = set(writeDb$);
      const [updated] = await writeDb
        .update(slackChatThreadRoutes)
        .set({ channelId: key.channelId })
        .where(
          and(
            eq(slackChatThreadRoutes.id, route.id),
            slackChatThreadRouteWhere(key),
          ),
        )
        .returning({ channelId: slackChatThreadRoutes.channelId });
      signal.throwIfAborted();
      if (!updated) {
        throw new Error("Failed to update Slack DM route destination");
      }
      return { ...route, ...updated };
    }
    return route;
  },
);

const ROUTE_COLUMNS = {
  id: slackChatThreadRoutes.id,
  connectionId: slackChatThreadRoutes.connectionId,
  channelId: slackChatThreadRoutes.channelId,
  threadTs: slackChatThreadRoutes.threadTs,
  userId: slackChatThreadRoutes.userId,
  chatThreadId: slackChatThreadRoutes.chatThreadId,
} as const;

const insertedSlackRouteSchema = z
  .object({
    id: z.uuid(),
    connection_id: z.uuid(),
    channel_id: z.string(),
    thread_ts: z.string(),
    user_id: z.string(),
    chat_thread_id: z.uuid(),
  })
  .transform((route): SlackChatThreadRouteBinding => {
    return {
      id: route.id,
      connectionId: route.connection_id,
      channelId: route.channel_id,
      threadTs: route.thread_ts,
      userId: route.user_id,
      chatThreadId: route.chat_thread_id,
    };
  });

function requireSlackDmDestination(rows: readonly { channelId: string }[]) {
  const [updated] = rows;
  if (!updated) {
    throw new Error("Failed to update Slack DM route destination");
  }
  return updated;
}

function requireSlackRouteAfterConflict(
  rows: readonly SlackChatThreadRouteBinding[],
) {
  const [winner] = rows;
  if (!winner) {
    throw new Error("Failed to resolve Slack chat thread route after conflict");
  }
  return winner;
}

/**
 * The unique route and its new thread/event commit in this command alone.
 * One `INSERT … ON CONFLICT DO NOTHING` decides a concurrent create; the loser
 * reads the committed winner once. The thread row is inserted by the same
 * statement only when the route insert wins.
 */
export const ensureCanonicalSlackChatThreadRoute$ = command(
  async (
    { set },
    args: SlackChatThreadRouteKey & IntegrationChatThreadCreation,
    signal: AbortSignal,
  ): Promise<SlackChatThreadRouteBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const candidateId = randomUUID();
    const db = set(writeDb$);
    const [existing] = await db
      .select(ROUTE_COLUMNS)
      .from(slackChatThreadRoutes)
      .where(slackChatThreadRouteWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (existing) {
      if (
        args.threadTs !== INTEGRATION_DM_SESSION_KEY ||
        existing.channelId === args.channelId
      ) {
        return existing;
      }
      const updated = requireSlackDmDestination(
        await db
          .update(slackChatThreadRoutes)
          .set({ channelId: args.channelId })
          .where(
            and(
              eq(slackChatThreadRoutes.id, existing.id),
              slackChatThreadRouteWhere(args),
            ),
          )
          .returning({ channelId: slackChatThreadRoutes.channelId }),
      );
      signal.throwIfAborted();
      return { ...existing, ...updated };
    }
    const thread = integrationChatThreadValues(args, candidateId, defaults);
    const routeInsert = db
      .insert(slackChatThreadRoutes)
      .values({
        connectionId: args.connectionId,
        channelId: args.channelId,
        threadTs: args.threadTs,
        userId: args.userId,
        chatThreadId: thread.id,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing({
        target: [
          slackChatThreadRoutes.connectionId,
          slackChatThreadRoutes.channelId,
          slackChatThreadRoutes.threadTs,
          slackChatThreadRoutes.userId,
        ],
      })
      .returning(ROUTE_COLUMNS);
    const insertedRoute = db.$with("inserted_slack_route").as(routeInsert);
    // A dependent CTE must consume RETURNING: it cannot see this newly
    // inserted thread in the statement's base-table snapshot.
    const insertedThread = sql`${integrationChatThreadInsertFromRouteSql(thread, insertedRoute)}
        RETURNING ${chatThreads.agentId}`;
    const [route] = parseRawRows(
      insertedSlackRouteSchema,
      await db.execute(
        integrationThreadCreatedEventSql(args.orgId, thread, {
          cte: sql`inserted_slack_route AS (${routeInsert.getSQL()}), inserted_slack_thread AS (${insertedThread})`,
          gate: exists(sql`(SELECT 1 FROM inserted_slack_thread)`),
          agentId: sql`(SELECT agent_id FROM inserted_slack_thread)`,
          result: db.select().from(insertedRoute).getSQL(),
        }),
      ),
    );
    signal.throwIfAborted();
    if (route) {
      return route;
    }
    // ON CONFLICT waited for the winner's commit; read it once.
    const winner = requireSlackRouteAfterConflict(
      await db
        .select(ROUTE_COLUMNS)
        .from(slackChatThreadRoutes)
        .where(slackChatThreadRouteWhere(args))
        .limit(1),
    );
    signal.throwIfAborted();
    if (
      args.threadTs !== INTEGRATION_DM_SESSION_KEY ||
      winner.channelId === args.channelId
    ) {
      return winner;
    }
    const updated = requireSlackDmDestination(
      await db
        .update(slackChatThreadRoutes)
        .set({ channelId: args.channelId })
        .where(
          and(
            eq(slackChatThreadRoutes.id, winner.id),
            slackChatThreadRouteWhere(args),
          ),
        )
        .returning({ channelId: slackChatThreadRoutes.channelId }),
    );
    signal.throwIfAborted();
    return { ...winner, ...updated };
  },
);

interface SlackChatIngressAdmission {
  readonly id: string;
  readonly inserted: boolean;
  readonly status: SlackChatIngressStatus;
  readonly retryCount: number;
}

export const admitCanonicalSlackChatEvent$ = command(
  async (
    { set },
    args: {
      readonly routeId: string;
      readonly eventId: string;
      readonly payload: string;
      readonly isRetry: boolean;
      readonly currentTime: Date;
    },
    signal: AbortSignal,
  ): Promise<SlackChatIngressAdmission> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [inserted] = await db
      .insert(slackChatIngress)
      .values({
        routeId: args.routeId,
        eventId: args.eventId,
        payload: args.payload,
        status: "pending",
        retryCount: args.isRetry ? 1 : 0,
        createdAt: args.currentTime,
        updatedAt: args.currentTime,
      })
      .onConflictDoNothing({ target: slackChatIngress.eventId })
      .returning({
        id: slackChatIngress.id,
        routeId: slackChatIngress.routeId,
        status: slackChatIngress.status,
        retryCount: slackChatIngress.retryCount,
      });
    signal.throwIfAborted();
    let result: SlackChatIngressAdmission;
    if (inserted) {
      result = { ...inserted, inserted: true };
    } else {
      const [existing] = await db
        .select({
          id: slackChatIngress.id,
          routeId: slackChatIngress.routeId,
          status: slackChatIngress.status,
          retryCount: slackChatIngress.retryCount,
        })
        .from(slackChatIngress)
        .where(eq(slackChatIngress.eventId, args.eventId))
        .limit(1);
      signal.throwIfAborted();
      if (!existing) {
        throw new Error("Failed to resolve canonical Slack ingress event");
      }
      if (existing.routeId !== args.routeId) {
        throw new Error("Slack event ID is already bound to another route");
      }
      if (!args.isRetry) {
        result = { ...existing, inserted: false };
      } else {
        const [retried] = await db
          .update(slackChatIngress)
          .set({
            retryCount: sql`${slackChatIngress.retryCount} + 1`,
            updatedAt: args.currentTime,
          })
          .where(eq(slackChatIngress.id, existing.id))
          .returning({
            id: slackChatIngress.id,
            status: slackChatIngress.status,
            retryCount: slackChatIngress.retryCount,
          });
        signal.throwIfAborted();
        if (!retried) {
          throw new Error("Failed to record canonical Slack ingress retry");
        }
        result = { ...retried, inserted: false };
      }
    }
    signal.throwIfAborted();
    return result;
  },
);
