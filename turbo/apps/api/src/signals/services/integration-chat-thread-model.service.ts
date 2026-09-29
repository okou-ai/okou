import { command } from "ccstate";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { and, eq } from "drizzle-orm";

import { writeDb$, type Db } from "../external/db";
import { resolveEnqueuedChatInputModel } from "./chat-input-model.service";
import { publishThreadListChanged } from "../external/realtime";
import { updateChatThreadMetadata } from "./chat-thread-metadata-update.service";

type IntegrationChatThreadModelResult =
  | { readonly kind: "updated" }
  | { readonly kind: "no_thread" }
  | { readonly kind: "rejected" };

/**
 * Apply an integration `/model` choice to the conversation's existing chat
 * thread through the same metadata path as the web thread model picker.
 * A conversation without a routed thread has no model selection to update.
 */
export async function readIntegrationChatThreadModel(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string | undefined;
  },
): Promise<string | null> {
  if (!args.chatThreadId) {
    return null;
  }
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  if (!thread) {
    return null;
  }
  return (
    await resolveEnqueuedChatInputModel(db, {
      threadId: thread.id,
      orgId: args.orgId,
      userId: args.userId,
    })
  ).selectedModel;
}

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
    const result = await updateChatThreadMetadata(
      set(writeDb$),
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
