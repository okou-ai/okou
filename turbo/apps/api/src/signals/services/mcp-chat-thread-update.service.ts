import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import type { McpChatMutationResult } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import type {
  McpUpdateChatThreadInput,
  McpUpdateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import { formatMcpChatTimestamp } from "@okouai/api-contracts/contracts/mcp-chat-time";
import { command } from "ccstate";
import { env } from "../../lib/env";
import { publishThreadListChanged } from "../external/realtime";
import { updateChatThreadMetadata$ } from "./chat-thread-metadata-update.service";

export const updateMcpChatThread$ = command(
  async (
    { set },
    args: {
      readonly principal: { readonly userId: string; readonly orgId: string };
      readonly input: McpUpdateChatThreadInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpUpdateChatThreadOutput>> => {
    const update = await set(
      updateChatThreadMetadata$,
      {
        principal: args.principal,
        threadId: args.input.threadId,
        patch: args.input.patch,
        codexServiceTier: { kind: "preserve" },
        emitServiceTierEvent: false,
      },
      signal,
    );
    if (update.kind === "not_found") {
      return {
        kind: "error",
        code: "not_found",
        message: "Chat thread not found.",
        retryable: false,
      };
    }
    if (update.kind === "response") {
      const { error } = apiErrorSchema.parse(update.response.body);
      return {
        kind: "error",
        code: error.code,
        message: error.message,
        retryable: false,
      };
    }
    await publishThreadListChanged(args.principal);
    signal.throwIfAborted();
    return {
      kind: "ok",
      data: {
        threadId: update.state.threadId,
        title: update.state.title,
        titleTruncated: update.state.titleTruncated,
        selectedModel: update.state.selectedModel,
        serviceTier: update.state.serviceTier,
        metadataUpdatedAt: formatMcpChatTimestamp(update.state.updatedAt),
        url: new URL(
          `/chats/${update.state.threadId}`,
          env("APP_URL"),
        ).toString(),
      },
    };
  },
);
