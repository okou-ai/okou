import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { loadNewChatThreadDefaults$ } from "./chat-thread-defaults.service";
import {
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
    .limit(1)
    .for("update");
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

/** The unique route and its new thread/event commit in this command alone. */
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
    const result = await db.transaction(async (tx) => {
      // No row lock: a route that disappears between the read and the DM
      // destination move is re-resolved, and a concurrent creator is found
      // through the unique route index (ON CONFLICT waits for its commit).
      let inserting = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const [existing] = await tx
          .select(ROUTE_COLUMNS)
          .from(telegramChatThreadRoutes)
          .innerJoin(
            chatThreads,
            eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
          )
          .where(routeWhere(args))
          .limit(1);
        if (existing) {
          if (
            args.rootMessageId === INTEGRATION_DM_SESSION_KEY &&
            existing.chatId !== args.chatId
          ) {
            const [updated] = await tx
              .update(telegramChatThreadRoutes)
              .set({ chatId: args.chatId })
              .where(
                and(
                  eq(telegramChatThreadRoutes.id, existing.id),
                  routeWhere(args),
                ),
              )
              .returning({ chatId: telegramChatThreadRoutes.chatId });
            if (!updated) {
              continue;
            }
            return { ...existing, ...updated };
          }
          return existing;
        }
        if (inserting) {
          break;
        }
        inserting = true;
        const thread = integrationChatThreadValues(args, candidateId, defaults);
        await tx.insert(chatThreads).values(thread);
        const [route] = await tx
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
        "Failed to resolve Telegram chat thread route after conflict",
      );
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
    await db.transaction(async (tx) => {
      await tx.insert(chatThreads).values(thread);
      await tx.execute(integrationThreadCreatedEventSql(args.orgId, thread));
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
    return { chatThreadId: thread.id };
  },
);
