import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { modelSettingsSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { resolveChatInputModelSelection$ } from "./chat-input-model.service";
import { updateChatThreadMetadata$ } from "./chat-thread-metadata-update.service";

export type IntegrationChatThreadModel =
  | { readonly kind: "no_thread" }
  /** `selectedModel` is null for Auto. */
  | { readonly kind: "thread"; readonly selectedModel: string | null };

/**
 * The string an integration `/model` picker uses for a run model option.
 * Auto is the empty (null) selection, so pickers carry it as `auto`.
 */
export function integrationModelOptionValue(model: string | null): string {
  return model ?? "auto";
}

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
  ): Promise<IntegrationChatThreadModel> => {
    if (!args.chatThreadId) {
      return { kind: "no_thread" };
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
      return { kind: "no_thread" };
    }
    if (thread.selectedModel === null) {
      return { kind: "thread", selectedModel: null };
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
    // A stored selection that no longer captures is still the thread's model;
    // the next queued input rejects it instead of switching models silently.
    return {
      kind: "thread",
      selectedModel:
        "status" in model ? thread.selectedModel : model.selectedModel,
    };
  },
);

export const updateIntegrationChatThreadModel$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string | undefined;
      /** Null selects Auto. */
      readonly model: string | null;
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
    }
  },
);
