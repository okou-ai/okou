import {
  slackChatIngress,
  type SlackChatIngressStatus,
} from "@okouai/db/schema/slack-chat-ingress";
import { slackChatThreadRoutes } from "@okouai/db/schema/slack-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import { writeDb$ } from "../external/db";
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
    { set },
    key: SlackChatThreadRouteKey,
    signal: AbortSignal,
  ): Promise<SlackChatThreadRouteBinding | undefined> => {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0243; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [route] = await tx
        .select(ROUTE_COLUMNS)
        .from(slackChatThreadRoutes)
        .where(slackChatThreadRouteWhere(key))
        .limit(1);
      if (
        route &&
        key.threadTs === INTEGRATION_DM_SESSION_KEY &&
        route.channelId !== key.channelId
      ) {
        const [updated] = await tx
          .update(slackChatThreadRoutes)
          .set({ channelId: key.channelId })
          .where(
            and(
              eq(slackChatThreadRoutes.id, route.id),
              slackChatThreadRouteWhere(key),
            ),
          )
          .returning({ channelId: slackChatThreadRoutes.channelId });
        if (!updated) {
          throw new Error("Failed to update Slack DM route destination");
        }
        signal.throwIfAborted();
        return { ...route, ...updated };
      }
      signal.throwIfAborted();
      return route;
    });
    signal.throwIfAborted();
    return result;
  },
);

/** Slash commands identify only the main direct-message conversation. */
export const findSlackDirectMessageChatThreadId$ = command(
  async (
    { set },
    key: Omit<SlackChatThreadRouteKey, "threadTs">,
    signal: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({ chatThreadId: slackChatThreadRoutes.chatThreadId })
      .from(slackChatThreadRoutes)
      .where(
        and(
          slackChatThreadRouteWhere({
            ...key,
            threadTs: INTEGRATION_DM_SESSION_KEY,
          }),
          eq(slackChatThreadRoutes.channelId, key.channelId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return route?.chatThreadId;
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0244; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select(ROUTE_COLUMNS)
        .from(slackChatThreadRoutes)
        .where(slackChatThreadRouteWhere(args))
        .limit(1);
      if (existing) {
        if (
          args.threadTs !== INTEGRATION_DM_SESSION_KEY ||
          existing.channelId === args.channelId
        ) {
          return existing;
        }
        const [updated] = await tx
          .update(slackChatThreadRoutes)
          .set({ channelId: args.channelId })
          .where(
            and(
              eq(slackChatThreadRoutes.id, existing.id),
              slackChatThreadRouteWhere(args),
            ),
          )
          .returning({ channelId: slackChatThreadRoutes.channelId });
        if (!updated) {
          throw new Error("Failed to update Slack DM route destination");
        }
        return { ...existing, ...updated };
      }
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insertedRoute = tx.$with("inserted_slack_route").as(
        tx
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
          .returning(ROUTE_COLUMNS),
      );
      const insertedThread = tx
        .$with("inserted_slack_thread", {})
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
      const [winner] = await tx
        .select(ROUTE_COLUMNS)
        .from(slackChatThreadRoutes)
        .where(slackChatThreadRouteWhere(args))
        .limit(1);
      if (!winner) {
        throw new Error(
          "Failed to resolve Slack chat thread route after conflict",
        );
      }
      if (
        args.threadTs !== INTEGRATION_DM_SESSION_KEY ||
        winner.channelId === args.channelId
      ) {
        return winner;
      }
      const [updated] = await tx
        .update(slackChatThreadRoutes)
        .set({ channelId: args.channelId })
        .where(
          and(
            eq(slackChatThreadRoutes.id, winner.id),
            slackChatThreadRouteWhere(args),
          ),
        )
        .returning({ channelId: slackChatThreadRoutes.channelId });
      if (!updated) {
        throw new Error("Failed to update Slack DM route destination");
      }
      return { ...winner, ...updated };
    });
    signal.throwIfAborted();
    return result;
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0245; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const [inserted] = await tx
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
      if (inserted) {
        return { ...inserted, inserted: true };
      }

      const [existing] = await tx
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
        return { ...existing, inserted: false };
      }

      const [retried] = await tx
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
      return { ...retried, inserted: false };
    });
    signal.throwIfAborted();
    return result;
  },
);
