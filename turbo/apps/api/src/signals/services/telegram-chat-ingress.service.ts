import { chatThreads } from "@okouai/db/schema/chat-thread";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "@okouai/db/schema/agent";
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

export type TelegramOwnerLink =
  | { readonly kind: "custom"; readonly id: string }
  | { readonly kind: "official"; readonly id: string };

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
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly codexServiceTier: "fast" | null;
  readonly computerUseHostId: string | null;
}

interface TelegramChatThreadCreateArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly selectedModel: string | null;
  readonly serviceTier: ChatThreadServiceTier | null;
  readonly currentTime: Date;
}

type TelegramChatThreadTransaction = Tx;

function ownerWhere(ownerLink: TelegramOwnerLink) {
  return ownerLink.kind === "custom"
    ? eq(telegramChatThreadRoutes.telegramUserLinkId, ownerLink.id)
    : eq(telegramChatThreadRoutes.telegramOfficialUserLinkId, ownerLink.id);
}

function routeWhere(key: TelegramChatThreadRouteKey) {
  return and(
    ownerWhere(key.ownerLink),
    eq(telegramChatThreadRoutes.chatId, key.chatId),
    eq(telegramChatThreadRoutes.rootMessageId, key.rootMessageId),
  );
}

function routeOwnerValues(ownerLink: TelegramOwnerLink): {
  readonly telegramUserLinkId: string | null;
  readonly telegramOfficialUserLinkId: string | null;
} {
  return ownerLink.kind === "custom"
    ? {
        telegramUserLinkId: ownerLink.id,
        telegramOfficialUserLinkId: null,
      }
    : {
        telegramUserLinkId: null,
        telegramOfficialUserLinkId: ownerLink.id,
      };
}

async function loadRoute(
  db: Pick<Db, "select">,
  key: TelegramChatThreadRouteKey,
): Promise<LoadedTelegramChatThreadRoute | undefined> {
  const [route] = await db
    .select({
      id: telegramChatThreadRoutes.id,
      chatThreadId: telegramChatThreadRoutes.chatThreadId,
      agentId: agents.id,
      selectedModel: chatThreads.selectedModel,
      codexServiceTier: chatThreads.codexServiceTier,
      computerUseHostId: chatThreads.computerUseHostId,
    })
    .from(telegramChatThreadRoutes)
    .innerJoin(
      chatThreads,
      eq(chatThreads.id, telegramChatThreadRoutes.chatThreadId),
    )
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(routeWhere(key))
    .limit(1)
    .for("update");
  return route;
}

interface CreatedTelegramChatThread {
  readonly id: string;
  readonly createdAt: Date;
  readonly mediaModels: NewChatThreadMediaModels;
  readonly modelSettings: ModelSettings;
}

async function createCanonicalTelegramChatThread(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadCreateArgs,
  computerUseHostId: string | null = null,
): Promise<CreatedTelegramChatThread> {
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
      computerUseHostId,
      selectedModel: args.selectedModel,
      modelSettings,
      codexServiceTier: args.serviceTier === "priority" ? "fast" : null,
      title: null,
      lastReadAt: args.currentTime,
      lastMessageAt: args.currentTime,
      createdAt: args.currentTime,
      updatedAt: args.currentTime,
      selectedVideoModel: mediaModels.selectedVideoModel,
      selectedImageModel: mediaModels.selectedImageModel,
    })
    .returning({ id: chatThreads.id, createdAt: chatThreads.createdAt });
  if (!thread) {
    throw new Error("Failed to create canonical Telegram chat thread");
  }
  return { ...thread, mediaModels, modelSettings };
}

async function appendCanonicalTelegramChatThreadCreatedEvent(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadCreateArgs,
  thread: CreatedTelegramChatThread,
  computerUseHostId: string | null | undefined,
): Promise<void> {
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: args.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: args.agentId,
    title: null,
    selectedModel: args.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: args.serviceTier,
    computerUseHostId,
    ...thread.mediaModels,
    createdAt: thread.createdAt,
  });
}

async function reconcileExistingRoute(
  tx: TelegramChatThreadTransaction,
  args: TelegramChatThreadRouteKey & TelegramChatThreadCreateArgs,
  existing: LoadedTelegramChatThreadRoute,
): Promise<TelegramChatThreadBinding> {
  if (existing.agentId !== args.agentId) {
    const thread = await createCanonicalTelegramChatThread(
      tx,
      args,
      existing.computerUseHostId,
    );
    const [route] = await tx
      .update(telegramChatThreadRoutes)
      .set({ chatThreadId: thread.id })
      .where(
        and(
          eq(telegramChatThreadRoutes.id, existing.id),
          eq(telegramChatThreadRoutes.chatThreadId, existing.chatThreadId),
        ),
      )
      .returning({ chatThreadId: telegramChatThreadRoutes.chatThreadId });
    if (!route) {
      throw new Error("Failed to rebind Telegram chat thread route");
    }
    await appendCanonicalTelegramChatThreadCreatedEvent(
      tx,
      args,
      thread,
      existing.computerUseHostId,
    );
    return route;
  }

  const selectedModelChanged = existing.selectedModel !== args.selectedModel;
  const codexServiceTier = args.serviceTier === "priority" ? "fast" : null;
  const serviceTierChanged = existing.codexServiceTier !== codexServiceTier;
  if (selectedModelChanged || serviceTierChanged) {
    const [thread] = await tx
      .update(chatThreads)
      .set({
        ...(selectedModelChanged
          ? {
              modelProviderId: null,
              modelProviderType: null,
              modelProviderCredentialScope: null,
              selectedModel: args.selectedModel,
            }
          : {}),
        codexServiceTier,
        updatedAt: args.currentTime,
      })
      .where(eq(chatThreads.id, existing.chatThreadId))
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Failed to update canonical Telegram thread model");
    }
    if (selectedModelChanged) {
      await appendChatThreadEvent(tx, {
        kind: "model_selection_updated",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: existing.chatThreadId,
        agentId: existing.agentId,
        selectedModel: args.selectedModel,
        createdAt: args.currentTime,
      });
    }
    if (serviceTierChanged) {
      await appendChatThreadEvent(tx, {
        kind: "service_tier_updated",
        userId: args.userId,
        orgId: args.orgId,
        chatThreadId: existing.chatThreadId,
        agentId: existing.agentId,
        serviceTier: args.serviceTier,
        createdAt: args.currentTime,
      });
    }
  }
  return existing;
}

export async function createTelegramChatThread(
  db: Db,
  args: TelegramChatThreadCreateArgs,
): Promise<TelegramChatThreadBinding> {
  return await db.transaction(async (tx) => {
    const thread = await createCanonicalTelegramChatThread(tx, args);
    await appendCanonicalTelegramChatThreadCreatedEvent(tx, args, thread, null);
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
      return await reconcileExistingRoute(tx, args, existing);
    }

    const thread = await createCanonicalTelegramChatThread(tx, args);
    const [route] = await tx
      .insert(telegramChatThreadRoutes)
      .values({
        ...routeOwnerValues(args.ownerLink),
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
      return await reconcileExistingRoute(tx, args, conflicted);
    }

    await appendCanonicalTelegramChatThreadCreatedEvent(tx, args, thread, null);
    return route;
  });
}

export async function persistTelegramReplyChainRoute(args: {
  readonly db: Db;
  readonly ownerLink: TelegramOwnerLink;
  readonly chatId: string;
  readonly previousRootMessageId: string | null;
  readonly botReplyMessageId: string;
  readonly chatThreadId: string;
  readonly runStatus: "completed" | "failed";
  readonly currentTime: Date;
}): Promise<void> {
  if (args.previousRootMessageId === "dm") {
    return;
  }

  if (args.previousRootMessageId === null) {
    const [inserted] = await args.db
      .insert(telegramChatThreadRoutes)
      .values({
        ...routeOwnerValues(args.ownerLink),
        chatId: args.chatId,
        rootMessageId: args.botReplyMessageId,
        chatThreadId: args.chatThreadId,
        createdAt: args.currentTime,
      })
      .onConflictDoNothing()
      .returning({ id: telegramChatThreadRoutes.id });
    if (inserted) {
      return;
    }
    const existing = await loadRoute(args.db, {
      ownerLink: args.ownerLink,
      chatId: args.chatId,
      rootMessageId: args.botReplyMessageId,
    });
    if (existing?.chatThreadId !== args.chatThreadId) {
      throw new Error(
        "Telegram reply-chain route conflicts with another thread",
      );
    }
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
