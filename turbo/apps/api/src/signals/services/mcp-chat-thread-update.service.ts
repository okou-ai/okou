import type {
  McpUpdateChatThreadInput,
  McpUpdateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import type { McpChatMutationResult } from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { command } from "ccstate";

import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import { publishThreadListChanged } from "../external/realtime";
import { settle } from "../utils";
import { updateChatThreadMetadata } from "./chat-thread-metadata-update.service";
import { mcpChatThreadModels } from "./mcp-chat-thread-model.service";

interface Principal {
  readonly userId: string;
  readonly orgId: string;
}

function responseMessage(response: { readonly body: unknown }): string {
  const body = response.body;
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return "The requested model selection is unavailable.";
}

export const updateMcpChatThread$ = command(
  async (
    { set },
    args: {
      readonly principal: Principal;
      readonly input: McpUpdateChatThreadInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpUpdateChatThreadOutput>> => {
    const operationSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(15_000),
    ]);
    const result = await settle(
      updateChatThreadMetadata(
        set(writeDb$),
        {
          principal: args.principal,
          threadId: args.input.threadId,
          patch: args.input.patch,
          codexServiceTier: { kind: "preserve" },
          emitServiceTierEvent: false,
          mutationId: args.input.requestId,
        },
        operationSignal,
      ),
      signal,
    );
    if (!result.ok) {
      throw result.error;
    }
    const update = result.value;
    if (update.kind === "not_found") {
      return {
        kind: "error",
        code: "not_found",
        message: "Chat thread not found.",
        retryable: false,
      };
    }
    if (update.kind === "closed") {
      return {
        kind: "error",
        code: "account_closed",
        message: "Account content is closed.",
        retryable: false,
      };
    }
    if (update.kind === "conflict" || update.kind === "expired") {
      return {
        kind: "error",
        code:
          update.kind === "conflict"
            ? "request_id_conflict"
            : "request_expired",
        message: update.message,
        retryable: false,
      };
    }
    if (update.kind === "response") {
      return {
        kind: "error",
        code: "selection_unavailable",
        message: responseMessage(update.response),
        retryable: false,
      };
    }

    const models = await mcpChatThreadModels(set(writeDb$), args.principal, [
      update.state.selectedModel,
    ]);
    signal.throwIfAborted();
    const model = models.get(update.state.selectedModel);
    if (!model) {
      throw new Error("Updated thread model projection is missing");
    }
    if (!update.replayed) {
      await publishThreadListChanged(args.principal);
      signal.throwIfAborted();
    }
    return {
      kind: "ok",
      data: {
        requestId: args.input.requestId,
        threadId: update.state.threadId,
        title: update.state.title,
        titleTruncated: update.state.titleTruncated,
        model,
        serviceTier: update.state.serviceTier,
        updatedAt: update.state.updatedAt.toISOString(),
        acceptedAt: update.acceptedAt.toISOString(),
        retryUntil: update.retryUntil.toISOString(),
        replayed: update.replayed,
        url: new URL(
          `/chats/${update.state.threadId}`,
          env("APP_URL"),
        ).toString(),
      },
    };
  },
);
