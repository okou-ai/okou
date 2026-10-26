import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq, sql } from "drizzle-orm";

import { db$, writeDb$ } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { object, string, uuid } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
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

export interface TelegramOwnerLink {
  readonly kind: "official";
  readonly id: string;
}

interface TelegramChatThreadRouteKey {
  readonly ownerLink: TelegramOwnerLink;
  readonly chatId: string;
  readonly rootMessageId: string;
}

interface TelegramChatThreadBinding {
  readonly chatThreadId: string;
}

type TelegramChatThreadCreateArgs = IntegrationChatThreadCreation;

function ownerWhere(ownerLink: TelegramOwnerLink) {
  return eq(telegramChatThreadRoutes.telegramOfficialUserLinkId, ownerLink.id);
}

function routeWhere(key: TelegramChatThreadRouteKey) {
  return and(
    ownerWhere(key.ownerLink),
    key.rootMessageId === INTEGRATION_DM_SESSION_KEY
      ? undefined
      : eq(telegramChatThreadRoutes.chatId, key.chatId),
    eq(telegramChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

export const persistTelegramReplyChainRoute$ = command(
  async (
    { set },
    args: {
      readonly ownerLink: TelegramOwnerLink;
      readonly chatId: string;
      readonly previousRootMessageId: string | null;
      readonly isDirectMessage: boolean;
      readonly botReplyMessageId: string;
      readonly chatThreadId: string;
      readonly runStatus: "completed" | "failed";
      readonly currentTime: Date;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    if (
      args.previousRootMessageId === "dm" ||
      (args.previousRootMessageId !== null &&
        isIntegrationDmSessionKey(args.previousRootMessageId))
    ) {
      return;
    }

    if (args.previousRootMessageId === null || args.isDirectMessage) {
      await set(bindTelegramReplyMessageRoute$, {
        ownerLink: args.ownerLink,
        chatId: args.chatId,
        rootMessageId: args.botReplyMessageId,
        chatThreadId: args.chatThreadId,
        currentTime: args.currentTime,
      });
      return;
    }

    if (args.runStatus !== "completed") {
      return;
    }
    const [updated] = await db
      .update(telegramChatThreadRoutes)
      .set({ rootMessageId: args.botReplyMessageId })
      .where(
        and(
          routeWhere({
            ownerLink: args.ownerLink,
            chatId: args.chatId,
            rootMessageId: args.previousRootMessageId,
          }),
          eq(telegramChatThreadRoutes.chatThreadId, args.chatThreadId),
        ),
      )
      .returning({ id: telegramChatThreadRoutes.id });
    if (updated) {
      return;
    }
    const key = {
      ownerLink: args.ownerLink,
      chatId: args.chatId,
      rootMessageId: args.botReplyMessageId,
    };
    let [existing] = await db
      .select({
        id: telegramChatThreadRoutes.id,
        chatId: telegramChatThreadRoutes.chatId,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
      })
      .from(telegramChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(key))
      .limit(1);
    // No row lock: the DM destination move is one conditional update pinned
    // to the route id.
    if (
      existing &&
      key.rootMessageId === INTEGRATION_DM_SESSION_KEY &&
      existing.chatId !== key.chatId
    ) {
      const [updatedDestination] = await db
        .update(telegramChatThreadRoutes)
        .set({ chatId: key.chatId })
        .where(
          and(eq(telegramChatThreadRoutes.id, existing.id), routeWhere(key)),
        )
        .returning({ chatId: telegramChatThreadRoutes.chatId });
      if (!updatedDestination) {
        throw new Error("Failed to update Telegram DM route destination");
      }
      existing = { ...existing, ...updatedDestination };
    }
    if (existing?.chatThreadId !== args.chatThreadId) {
      throw new Error("Failed to advance Telegram reply-chain route");
    }
  },
);

export const bindTelegramReplyMessageRoute$ = command(
  async (
    { set },
    args: TelegramChatThreadRouteKey & {
      readonly chatThreadId: string;
      readonly currentTime: Date;
    },
  ): Promise<void> => {
    const db = set(writeDb$);
    const [inserted] = await db
      .insert(telegramChatThreadRoutes)
      .values({
        telegramOfficialUserLinkId: args.ownerLink.id,
        chatId: args.chatId,
        rootMessageId: args.rootMessageId,
        chatThreadId: args.chatThreadId,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: telegramChatThreadRoutes.id });
    if (inserted) {
      return;
    }
    let [existing] = await db
      .select({
        id: telegramChatThreadRoutes.id,
        chatId: telegramChatThreadRoutes.chatId,
        chatThreadId: telegramChatThreadRoutes.chatThreadId,
      })
      .from(telegramChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(args))
      .limit(1);
    // No row lock: the DM destination move is one conditional update pinned
    // to the route id.
    if (
      existing &&
      args.rootMessageId === INTEGRATION_DM_SESSION_KEY &&
      existing.chatId !== args.chatId
    ) {
      const [updated] = await db
        .update(telegramChatThreadRoutes)
        .set({ chatId: args.chatId })
        .where(
          and(eq(telegramChatThreadRoutes.id, existing.id), routeWhere(args)),
        )
        .returning({ chatId: telegramChatThreadRoutes.chatId });
      if (!updated) {
        throw new Error("Failed to update Telegram DM route destination");
      }
      existing = { ...existing, ...updated };
    }
    if (existing?.chatThreadId !== args.chatThreadId) {
      throw new Error(
        "Telegram reply-chain route conflicts with another thread",
      );
    }
  },
);

const ROUTE_COLUMNS = {
  id: telegramChatThreadRoutes.id,
  chatId: telegramChatThreadRoutes.chatId,
  chatThreadId: telegramChatThreadRoutes.chatThreadId,
} as const;

/**
 * The unique route and its new thread/event commit in this command alone.
 * One `INSERT … ON CONFLICT DO NOTHING` decides a concurrent create; the loser
 * reads the committed winner once. The thread row is inserted by the same
 * statement only when the route insert wins.
 */
export const ensureTelegramChatThreadRoute$ = command(
  async (
    { get, set },
    args: TelegramChatThreadRouteKey & TelegramChatThreadCreateArgs,
    signal: AbortSignal,
  ): Promise<TelegramChatThreadBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const candidateId = randomUUID();
    const db = set(writeDb$);
    const readDb = get(db$);
    let [route] = await readDb
      .select(ROUTE_COLUMNS)
      .from(telegramChatThreadRoutes)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
      )
      .where(routeWhere(args))
      .limit(1);
    signal.throwIfAborted();
    if (!route) {
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insert = db
        .insert(telegramChatThreadRoutes)
        .values({
          telegramOfficialUserLinkId: args.ownerLink.id,
          chatId: args.chatId,
          rootMessageId: args.rootMessageId,
          chatThreadId: thread.id,
          createdAt: args.currentTime,
        })
        .onConflictDoNothing()
        .returning(ROUTE_COLUMNS);
      const insertedRoute = db.$with("inserted_telegram_route").as(insert);
      // RETURNING gates publication; the statement snapshot cannot see the
      // new thread through its base table. A conflict loser writes nothing.
      const statement = integrationThreadCreatedEventSql(args.orgId, thread, {
        cte: sql`inserted_telegram_route AS (${insert.getSQL()}),
          inserted_telegram_thread AS (
            ${integrationChatThreadInsertFromRouteSql(thread, insertedRoute)}
            RETURNING ${chatThreads.agentId}
          )`,
        gate: sql`EXISTS (SELECT 1 FROM inserted_telegram_thread)`,
        agentId: sql`(SELECT agent_id FROM inserted_telegram_thread)`,
        result: sql`SELECT id, chat_id AS "chatId", chat_thread_id AS "chatThreadId"
          FROM inserted_telegram_route`,
      });
      const [inserted] = parseRawRows(
        object({ id: uuid(), chatId: string(), chatThreadId: uuid() }),
        await db.execute(statement),
      );
      signal.throwIfAborted();
      if (inserted) {
        return inserted;
      }
      // ON CONFLICT waited for the winner's commit; read it once in a fresh
      // statement, never through the creation statement's old snapshot.
      [route] = await readDb
        .select(ROUTE_COLUMNS)
        .from(telegramChatThreadRoutes)
        .innerJoin(
          chatThreads,
          eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
        )
        .where(routeWhere(args))
        .limit(1);
      if (!route) {
        throw new Error(
          "Failed to resolve Telegram chat thread route after conflict",
        );
      }
      signal.throwIfAborted();
    }
    // Existing and freshly read winner routes share the original conditional
    // destination adoption, pinned to the route id and exact DM predicate.
    if (
      args.rootMessageId === INTEGRATION_DM_SESSION_KEY &&
      route.chatId !== args.chatId
    ) {
      const [updated] = await db
        .update(telegramChatThreadRoutes)
        .set({ chatId: args.chatId })
        .where(and(eq(telegramChatThreadRoutes.id, route.id), routeWhere(args)))
        .returning({ chatId: telegramChatThreadRoutes.chatId });
      if (signal.aborted) {
        if (updated) {
          signal.throwIfAborted();
        }
      }
      if (!updated) {
        throw new Error("Failed to update Telegram DM route destination");
      }
      route = { ...route, ...updated };
    }
    signal.throwIfAborted();
    return route;
  },
);

export const createTelegramChatThread$ = command(
  async (
    { set },
    args: TelegramChatThreadCreateArgs,
    signal: AbortSignal,
  ): Promise<TelegramChatThreadBinding> => {
    const defaults = await set(
      loadNewChatThreadDefaults$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    const thread = integrationChatThreadValues(args, randomUUID(), defaults);
    const db = set(writeDb$);
    const insert = db
      .insert(chatThreads)
      .values(thread)
      .returning({ agentId: chatThreads.agentId });
    // Use RETURNING: another CTE cannot read this inserted base row in the
    // statement snapshot. Creation, sequence reservation and publication commit
    // together, with the event's agent identity coming from the inserted row.
    await db.execute(
      integrationThreadCreatedEventSql(args.orgId, thread, {
        cte: sql`inserted_thread AS (${insert.getSQL()})`,
        gate: sql`EXISTS (SELECT 1 FROM inserted_thread)`,
        agentId: sql`(SELECT agent_id FROM inserted_thread)`,
      }),
    );
    signal.throwIfAborted();
    return { chatThreadId: thread.id };
  },
);
