import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { updateChatThreadMetadata } from "./chat-thread-metadata-update.service";

type IntegrationChatThreadModelResult =
  | { readonly kind: "updated" }
  | { readonly kind: "no_thread" }
  | { readonly kind: "rejected" };

/**
 * Apply an integration `/model` choice to the conversation's existing chat
 * thread through the same metadata path as the web thread model picker. A
 * conversation without a routed thread keeps only the member default.
 */
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
