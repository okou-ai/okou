import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
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

interface LoadedTelegramChatThreadRoute extends TelegramChatThreadBinding {
  readonly id: string;
  readonly chatId: string;
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

/** Read the chat thread a Telegram conversation already routes to. */
export const findTelegramRoutedChatThreadId$ = command(
  async (
    { set },
    key: TelegramChatThreadRouteKey,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    const db = set(writeDb$);
    const [route] = await db
      .select({ chatThreadId: telegramChatThreadRoutes.chatThreadId })
      .from(telegramChatThreadRoutes)
      .where(routeWhere(key))
      .limit(1);
    signal?.throwIfAborted();
    return route?.chatThreadId;
  },
);

async function loadRoute(
  db: Pick<Db, "select" | "update">,
  key: TelegramChatThreadRouteKey,
): Promise<LoadedTelegramChatThreadRoute | undefined> {
  const [route] = await db
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
    route &&
    key.rootMessageId === INTEGRATION_DM_SESSION_KEY &&
    route.chatId !== key.chatId
  ) {
    const [updated] = await db
      .update(telegramChatThreadRoutes)
      .set({ chatId: key.chatId })
      .where(and(eq(telegramChatThreadRoutes.id, route.id), routeWhere(key)))
      .returning({ chatId: telegramChatThreadRoutes.chatId });
    if (!updated) {
      throw new Error("Failed to update Telegram DM route destination");
    }
    return { ...route, ...updated };
  }
  return route;
}

export async function persistTelegramReplyChainRoute(args: {
  readonly db: Db;
  readonly ownerLink: TelegramOwnerLink;
  readonly chatId: string;
  readonly previousRootMessageId: string | null;
  readonly isDirectMessage: boolean;
  readonly botReplyMessageId: string;
  readonly chatThreadId: string;
  readonly runStatus: "completed" | "failed";
  readonly currentTime: Date;
}): Promise<void> {
  if (
    args.previousRootMessageId === "dm" ||
    (args.previousRootMessageId !== null &&
      isIntegrationDmSessionKey(args.previousRootMessageId))
  ) {
    return;
  }

  if (args.previousRootMessageId === null || args.isDirectMessage) {
    await bindTelegramReplyMessageRoute(args.db, {
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
  const [updated] = await args.db
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
  const existing = await loadRoute(args.db, {
    ownerLink: args.ownerLink,
    chatId: args.chatId,
    rootMessageId: args.botReplyMessageId,
  });
  if (existing?.chatThreadId !== args.chatThreadId) {
    throw new Error("Failed to advance Telegram reply-chain route");
  }
}

export async function bindTelegramReplyMessageRoute(
  db: Pick<Db, "insert" | "select" | "update">,
  args: TelegramChatThreadRouteKey & {
    readonly chatThreadId: string;
    readonly currentTime: Date;
  },
): Promise<void> {
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
  const existing = await loadRoute(db, args);
  if (existing?.chatThreadId !== args.chatThreadId) {
    throw new Error("Telegram reply-chain route conflicts with another thread");
  }
}

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
    { set },
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0259; new non-billing transactions are prohibited.
    const result = await db.transaction(async (tx) => {
      const existing = await loadRoute(tx, args);
      if (existing) {
        return existing;
      }
      const thread = integrationChatThreadValues(args, candidateId, defaults);
      const insertedRoute = tx.$with("inserted_telegram_route").as(
        tx
          .insert(telegramChatThreadRoutes)
          .values({
            telegramOfficialUserLinkId: args.ownerLink.id,
            chatId: args.chatId,
            rootMessageId: args.rootMessageId,
            chatThreadId: thread.id,
            createdAt: args.currentTime,
          })
          .onConflictDoNothing()
          .returning(ROUTE_COLUMNS),
      );
      const insertedThread = tx
        .$with("inserted_telegram_thread", {})
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
      const winner = await loadRoute(tx, args);
      if (!winner) {
        throw new Error(
          "Failed to resolve Telegram chat thread route after conflict",
        );
      }
      return winner;
    });
    signal.throwIfAborted();
    return result;
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0260; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      await tx.insert(chatThreads).values(thread);
      await tx.execute(integrationThreadCreatedEventSql(args.orgId, thread));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    return { chatThreadId: thread.id };
  },
);
