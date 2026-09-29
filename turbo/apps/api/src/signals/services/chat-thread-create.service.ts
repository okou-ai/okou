import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelSettings } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import type { SQL } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { loadNewChatThreadDefaults } from "./chat-thread-defaults.service";
import {
  appendChatThreadEvent,
  chatThreadServiceTierFromCodex,
} from "./chat-thread-event.service";

interface NewChatThreadArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly id?: string;
  readonly title?: string | null;
  readonly modelProviderId?: string | null;
  readonly modelProviderType?: string | null;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly modelSettings?: ModelSettings;
  readonly codexServiceTier: CodexServiceTier | null;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly lastReadAt?: Date | SQL;
  readonly lastMessageAt?: Date;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

/** All creation paths resolve Chat defaults here; explicit selections win. */
export async function insertChatThread(tx: Tx, args: NewChatThreadArgs) {
  const { orgId, ...values } = args;
  const defaults =
    args.modelSettings !== undefined && args.cloudBrowserEnabled !== undefined
      ? {
          modelSettings: args.modelSettings,
          cloudBrowserEnabled: args.cloudBrowserEnabled,
        }
      : await loadNewChatThreadDefaults(tx, { orgId, userId: args.userId });
  const computerUseHostId =
    args.cloudBrowserEnabled === true ? null : (args.computerUseHostId ?? null);
  const [thread] = await tx
    .insert(chatThreads)
    .values({
      ...values,
      modelSettings: args.modelSettings ?? defaults.modelSettings,
      computerUseHostId,
      cloudBrowserEnabled: computerUseHostId
        ? false
        : (args.cloudBrowserEnabled ?? defaults.cloudBrowserEnabled),
    })
    // Both the primary key and (id, user_id) are unique. Skip either conflict
    // so the caller can apply its own owner-scoped replay policy.
    .onConflictDoNothing()
    .returning({
      id: chatThreads.id,
      userId: chatThreads.userId,
      title: chatThreads.title,
      selectedModel: chatThreads.selectedModel,
      modelSettings: chatThreads.modelSettings,
      codexServiceTier: chatThreads.codexServiceTier,
      computerUseHostId: chatThreads.computerUseHostId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
      createdAt: chatThreads.createdAt,
    });
  return thread ? { ...thread, agentId: args.agentId } : undefined;
}

/** Append only after the caller wins any integration route conflict. */
export async function appendChatThreadCreatedEvent(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly eventId?: string;
    readonly thread: NonNullable<Awaited<ReturnType<typeof insertChatThread>>>;
  },
): Promise<void> {
  const { thread } = args;
  await appendChatThreadEvent(tx, {
    kind: "created",
    userId: thread.userId,
    orgId: args.orgId,
    chatThreadId: thread.id,
    agentId: thread.agentId,
    eventId: args.eventId,
    title: thread.title,
    selectedModel: thread.selectedModel,
    modelSettings: thread.modelSettings,
    serviceTier: chatThreadServiceTierFromCodex(thread.codexServiceTier),
    computerUseHostId: thread.computerUseHostId,
    cloudBrowserEnabled: thread.cloudBrowserEnabled,
    createdAt: thread.createdAt,
  });
}
