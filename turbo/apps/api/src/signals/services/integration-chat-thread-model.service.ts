import { command } from "ccstate";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { resolveChatInputModelSelection$ } from "./chat-input-model.service";
import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { publishThreadListChanged } from "../external/realtime";
import { updateChatThreadMetadata$ } from "./chat-thread-metadata-update.service";

type IntegrationChatThreadModelResult =
  | { readonly kind: "updated" }
  | { readonly kind: "no_thread" }
  | { readonly kind: "rejected" };

/**
 * Apply an integration `/model` choice to the conversation's existing chat
 * thread through the same metadata path as the web thread model picker.
 * A conversation without a routed thread has no model selection to update.
 */
export const readIntegrationChatThreadModel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (!args.chatThreadId) {
      return null;
    }
    const db = set(writeDb$);
    const [thread] = await db
      .select({
        selectedModel: chatThreads.selectedModel,
        codexServiceTier: chatThreads.codexServiceTier,
        modelSettings: chatThreads.modelSettings,
      })
      .from(chatThreads)
      .where(
        and(
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }
    const model = await set(
      resolveChatInputModelSelection$,
      {
        ...thread,
        orgId: args.orgId,
        userId: args.userId,
        modelSettings: modelSettingsSchema.parse(thread.modelSettings),
      },
      signal,
    );
    signal.throwIfAborted();
    return model.selectedModel;
  },
);

export const updateIntegrationChatThreadModel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string | undefined;
      readonly model: string;
    },
    signal: AbortSignal,
  ): Promise<IntegrationChatThreadModelResult> => {
    if (args.chatThreadId === undefined) {
      return { kind: "no_thread" };
    }
    const result = await set(
      updateChatThreadMetadata$,
      {
        principal: { userId: args.userId, orgId: args.orgId },
        threadId: args.chatThreadId,
        patch: { model: args.model },
        codexServiceTier: { kind: "set", value: null },
        emitServiceTierEvent: true,
      },
      signal,
    );
    signal.throwIfAborted();
    switch (result.kind) {
      case "ok": {
        await publishThreadListChanged({
          userId: args.userId,
          orgId: args.orgId,
        });
        signal.throwIfAborted();
        return { kind: "updated" };
      }
      case "not_found": {
        return { kind: "no_thread" };
      }
      case "response": {
        return { kind: "rejected" };
      }
      case "conflict":
      case "expired": {
        throw new Error(
          `Unexpected ${result.kind} for an unkeyed model update`,
        );
      }
    }
  },
);
