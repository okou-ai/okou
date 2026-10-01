import type {
  McpCancelRunInput,
  McpCancelRunOutput,
  McpChatMutationResult,
  McpRevokeQueuedMessageInput,
  McpRevokeQueuedMessageOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { command } from "ccstate";
import { handleSendChatEvent$ } from "./chat-events.command";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "./run-cancel.service";

/** Uses the verified request auth installed by the MCP entry point, just like Web. */
export const revokeQueuedMcpMessage$ = command(
  async (
    { set },
    { input }: { readonly input: McpRevokeQueuedMessageInput },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpRevokeQueuedMessageOutput>> => {
    const result = await set(handleSendChatEvent$, input, signal);
    if (result.status !== 201) {
      return {
        kind: "error",
        code: result.body.error.code,
        message: result.body.error.message,
        retryable: false,
      };
    }
    return { kind: "ok", data: result.body };
  },
);

export const cancelMcpRun$ = command(
  async (
    { set },
    {
      principal,
      input,
    }: {
      readonly principal: { readonly userId: string; readonly orgId: string };
      readonly input: McpCancelRunInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpCancelRunOutput>> => {
    const result = await set(
      cancelRun$,
      {
        ...principal,
        runId: input.runId,
        runnerCancellationMode: "cooperative",
      },
      signal,
    );
    if (!("alreadyCancelled" in result)) {
      return {
        kind: "error",
        code: result.body.error.code,
        message: result.body.error.message,
        retryable: false,
      };
    }
    if (shouldDispatchCancelSideEffects(result)) {
      await set(dispatchCancelSideEffects$, result, signal);
    }
    return {
      kind: "ok",
      data: {
        runId: result.runId,
        status: "cancelled",
        alreadyCancelled: result.alreadyCancelled,
      },
    };
  },
);
