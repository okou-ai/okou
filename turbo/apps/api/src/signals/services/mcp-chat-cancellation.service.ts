import type {
  McpCancelRunInput,
  McpCancelRunOutput,
  McpChatMutationResult,
  McpRevokeQueuedMessageInput,
  McpRevokeQueuedMessageOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import { command } from "ccstate";
import { handleSendChatEvent$ } from "./chat-events.command";
import { readCanonicalMcpChatInput$ } from "./mcp-chat-input.service";
import { cancelRun$ } from "./agent-run-terminal-transition.service";
import {
  dispatchCancelSideEffects$,
  shouldDispatchCancelSideEffects,
} from "./run-cancel.service";

/** Uses the verified request auth installed by the MCP entry point, just like Web. */
export const revokeQueuedMcpMessage$ = command(
  async (
    { set },
    {
      principal,
      input,
    }: {
      readonly principal: { readonly userId: string; readonly orgId: string };
      readonly input: McpRevokeQueuedMessageInput;
    },
    signal: AbortSignal,
  ): Promise<McpChatMutationResult<McpRevokeQueuedMessageOutput>> => {
    const before = await set(
      readCanonicalMcpChatInput$,
      principal,
      {
        threadId: input.threadId,
        eventId: input.eventId,
      },
      signal,
    );
    if (before.kind !== "ok") {
      return {
        kind: "error",
        code: before.kind,
        message: before.message,
        retryable: false,
      };
    }
    const current = before.data.current;
    if (
      current.runId !== undefined ||
      (current.eventType === "input.rejected" &&
        current.error !== "insufficient_credits")
    ) {
      return {
        kind: "error",
        code: "bad_request",
        message: "Only queued user messages can be recalled",
        retryable: false,
      };
    }
    const revokesEventId =
      current.eventType === "control.revoke"
        ? current.revokesEventId
        : current.id;
    if (revokesEventId === undefined) {
      return {
        kind: "error",
        code: "history_unavailable",
        message: "The canonical recall target is unavailable.",
        retryable: false,
      };
    }
    const result = await set(
      handleSendChatEvent$,
      {
        agentId: input.agentId,
        threadId: input.threadId,
        revokesEventId,
      },
      signal,
    );
    if (result.status !== 201) {
      return {
        kind: "error",
        code: result.body.error.code,
        message: result.body.error.message,
        retryable: false,
      };
    }
    const after =
      current.eventType === "control.revoke"
        ? before
        : await set(
            readCanonicalMcpChatInput$,
            principal,
            {
              threadId: input.threadId,
              eventId: input.eventId,
            },
            signal,
          );
    if (after.kind !== "ok") {
      return {
        kind: "error",
        code: after.kind,
        message: after.message,
        retryable: false,
      };
    }
    if (after.data.current.eventType !== "control.revoke") {
      return {
        kind: "error",
        code: "reference_unavailable",
        message:
          "Recall was not recorded for this input. Inspect get_chat_input; retained inputs may no longer be recallable in the live queue.",
        retryable: false,
      };
    }
    return {
      kind: "ok",
      data: {
        threadId: input.threadId,
        eventId: input.eventId,
        createdAt: after.data.current.createdAt,
      },
    };
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
