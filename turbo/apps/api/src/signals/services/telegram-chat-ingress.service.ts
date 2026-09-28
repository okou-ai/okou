import { resolveRequiredDefaultChatThreadModelPin } from "./chat-thread-model.service";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { telegramChatThreadRoutes } from "@okouai/db/schema/telegram-chat-thread-route";
import { and, eq } from "drizzle-orm";

import type { Db } from "../external/db";
import { appendChatThreadEvent } from "./chat-thread-event.service";
import {
  loadNewChatThreadMediaModels,
  type NewChatThreadMediaModels,
} from "./chat-thread-media-model.service";
import { loadNewChatThreadModelSettings } from "./chat-thread-model-settings.service";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { Tx } from "../../lib/db-types";
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

interface TelegramChatThreadCreateArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly currentTime: Date;
}

type TelegramChatThreadTransaction = Tx;

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
export async function findTelegramRoutedChatThreadId(
  db: Pick<Db, "select">,
  key: TelegramChatThreadRouteKey,
): Promise<string | undefined> {
  const [route] = await db
    .select({ chatThreadId: telegramChatThreadRoutes.chatThreadId })
    .from(telegramChatThreadRoutes)
    .where(routeWhere(key))
    .limit(1);
  return route?.chatThreadId;
}

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

interface CreatedTelegramChatThread {
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly id: string;
  readonly createdAt: Date;
  readonly mediaModels: NewChatThreadMediaModels;
  readonly modelSettings: ModelSettings;
}

async function createCanonicalTelegramChatThread(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadCreateArgs,
): Promise<CreatedTelegramChatThread> {
  const initialModel = await resolveRequiredDefaultChatThreadModelPin(tx, args);
  const mediaModels = await loadNewChatThreadMediaModels(tx, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const modelSettings = await loadNewChatThreadModelSettings(tx, {
    orgId: args.orgId,
    userId: args.userId,
  });
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      userId: args.userId,
      agentId: args.agentId,
      computerUseHostId: null,
      cloudBrowserEnabled: false,
      selectedModel: initialModel.selectedModel,
      modelSettings,
      codexServiceTier: initialModel.serviceTier === "priority" ? "fast" : null,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical Telegram chat thread");
  }
  return {
    ...thread,
    mediaModels,
    modelSettings,
    selectedModel: initialModel.selectedModel,
    serviceTier: initialModel.serviceTier,
  };
}

async function appendCanonicalTelegramChatThreadCreatedEvent(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadCreateArgs,
  thread: CreatedTelegramChatThread,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: null,
    selectedModel: thread.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: thread.serviceTier,
    computerUseHostId: null,
    ...thread.mediaModels,
    createdAt: thread.createdAt,
  });
}

export async function createTelegramChatThread(
  db: Db,
  args: TelegramChatThreadCreateArgs,
): Promise<TelegramChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const thread = await createCanonicalTelegramChatThread(tx, args);
    await appendCanonicalTelegramChatThreadCreatedEvent(tx, args, thread);
    return { chatThreadId: thread.id };
  });
}

export async function ensureTelegramChatThreadRoute(
  db: Db,
  args: TelegramChatThreadRouteKey & TelegramChatThreadCreateArgs,
): Promise<TelegramChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const existing = await loadRoute(tx, args);
    if (existing) {
      return existing;
    }

    const thread = await createCanonicalTelegramChatThread(tx, args);
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
      .returning({ chatThreadId: telegramChatThreadRoutes.chatThreadId });
    if (!route) {
      await tx.delete(chatThreads).where(eq(chatThreads.id, thread.id));
      const conflicted = await loadRoute(tx, args);
      if (!conflicted) {
        throw new Error(
          "Failed to resolve Telegram chat thread route after conflict",
        );
      }
      return conflicted;
    }

    await appendCanonicalTelegramChatThreadCreatedEvent(tx, args, thread);
    return route;
  });
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
