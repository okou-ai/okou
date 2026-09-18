import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  mcpSendChatMessageInputSchema,
  mcpSendChatMessageOutputSchema,
  mcpRevokeQueuedMessageInputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpCancelRunInputSchema,
  mcpCancelRunOutputSchema,
  type McpSendChatMessageInput,
  type McpSendChatMessageOutput,
  type McpRevokeQueuedMessageInput,
  type McpRevokeQueuedMessageOutput,
  type McpCancelRunInput,
  type McpCancelRunOutput,
  type McpChatMutationResult,
} from "@okouai/api-contracts/contracts/mcp-chat-mutations";
import {
  mcpSearchChatMessagesInputSchema,
  mcpSearchChatMessagesOutputSchema,
  type McpSearchChatMessagesInput,
  type McpChatSearchResult,
} from "@okouai/api-contracts/contracts/mcp-chat-search";
import {
  mcpGetChatMessagesInputSchema,
  mcpGetChatMessagesOutputSchema,
  type McpGetChatMessagesInput,
  type McpMessageReadResult,
} from "@okouai/api-contracts/contracts/mcp-chat-messages";
import {
  mcpGetChatThreadInputSchema,
  mcpGetChatThreadOutputSchema,
  mcpListChatThreadsInputSchema,
  mcpListChatThreadsOutputSchema,
  type McpGetChatThreadInput,
  type McpGetChatThreadOutput,
  type McpListChatThreadsInput,
  type McpListChatThreadsOutput,
  type McpThreadReadResult,
} from "@okouai/api-contracts/contracts/mcp-chat-threads";
import { onRejection, settle, settleIncludingAbort } from "../utils";

interface McpChatAccess {
  readonly readScope: string;
  readonly scopes: readonly string[];
  readonly sendMessage: (
    input: McpSendChatMessageInput,
    signal: AbortSignal,
  ) => Promise<McpChatMutationResult<McpSendChatMessageOutput>>;
  readonly revokeQueuedMessage: (
    input: McpRevokeQueuedMessageInput,
    signal: AbortSignal,
  ) => Promise<McpChatMutationResult<McpRevokeQueuedMessageOutput>>;
  readonly cancelRun: (
    input: McpCancelRunInput,
    signal: AbortSignal,
  ) => Promise<McpChatMutationResult<McpCancelRunOutput>>;
  readonly searchMessages: (
    input: McpSearchChatMessagesInput,
    signal: AbortSignal,
  ) => Promise<McpChatSearchResult>;
  readonly listThreads: (
    input: McpListChatThreadsInput,
    signal: AbortSignal,
  ) => Promise<McpThreadReadResult<McpListChatThreadsOutput>>;
  readonly getThread: (
    input: McpGetChatThreadInput,
    signal: AbortSignal,
  ) => Promise<McpThreadReadResult<McpGetChatThreadOutput>>;
  readonly getMessages: (
    input: McpGetChatMessagesInput,
    signal: AbortSignal,
  ) => Promise<McpMessageReadResult>;
}

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

async function readTool<T extends Record<string, unknown>>(
  access: McpChatAccess,
  operation: () => Promise<
    | { readonly kind: "ok"; readonly data: T }
    | { readonly kind: string; readonly message: string }
  >,
  signal: AbortSignal,
  unavailableMessage = "Thread information is temporarily unavailable. Retry, or narrow the Agent/time filters for a large search.",
) {
  if (!access.scopes.includes(access.readScope)) {
    return toolError("Insufficient scope");
  }
  signal.throwIfAborted();
  const result = await settle(operation(), signal);
  if (!result.ok) {
    return toolError(unavailableMessage);
  }
  if (!("data" in result.value)) {
    return toolError(result.value.message);
  }
  return {
    structuredContent: result.value.data,
    content: [
      { type: "text" as const, text: JSON.stringify(result.value.data) },
    ],
  };
}

function registerMessageTool(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  server.registerTool(
    "get_chat_messages",
    {
      description:
        "Read visible messages in your conversation in the authorized organization. Defaults to the latest 20 " +
        "messages, presented in conversation run-turn order. Filter by runId, or use around with a real " +
        "eventId/seqId reference for context. Follow olderCursor/newerCursor with the same threadId, runId " +
        "and limit, omitting around. Follow each message's nextContentCursor to finish its text/files. " +
        "Offsets count UTF-16 text units and file entries. History changes require restarting page cursors; " +
        "unrelated appends preserve content cursors. References and private artifact links retain their " +
        "existing authorization. This does not mark messages read. Supports histories within 8 MiB gzip, " +
        "32 MiB decoded plus database tail, 50,000 events and 15 seconds; larger histories fail explicitly.",
      inputSchema: mcpGetChatMessagesInputSchema,
      outputSchema: mcpGetChatMessagesOutputSchema,
      annotations: readAnnotations,
    },
    async (args, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return await readTool(
        access,
        () => {
          return access.getMessages(args, signal);
        },
        signal,
        "Conversation history is temporarily unavailable. Retry later.",
      );
    },
  );
}

async function mutationTool<T extends Record<string, unknown>>(
  access: McpChatAccess,
  scope: string,
  operation: (signal: AbortSignal) => Promise<McpChatMutationResult<T>>,
  requestSignal: AbortSignal,
) {
  if (!access.scopes.includes(scope)) {
    return toolError("Insufficient scope");
  }
  requestSignal.throwIfAborted();
  const result = await settle(operation(requestSignal), requestSignal);
  if (!result.ok) {
    return toolError(
      "The operation result is unavailable. For sends, retry the identical requestId, threadId and text within 24 hours; otherwise inspect the current state before retrying.",
    );
  }
  if (result.value.kind === "error") {
    return toolError(result.value.message);
  }
  return {
    structuredContent: result.value.data,
    content: [
      { type: "text" as const, text: JSON.stringify(result.value.data) },
    ],
  };
}

function registerMutationTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  if (access.scopes.includes("okou:chat:send")) {
    server.registerTool(
      "send_chat_message",
      {
        description:
          "Submit text to your existing conversation in the authorized organization. The server may start a run, queue the input, or steer an active run. Generate a new UUID requestId for each intended message; retry only with identical threadId and exact text using that same requestId within 24 hours of acceptance. Deduplication is not guaranteed after that window; inspect history before intentionally submitting new work, and never automatically retry an uncertain old request. inputRef identifies the original submitted input, which can be replaced in visible history. disposition is the current observation, not proof of delivery or run success; runId may be null. Use get_chat_messages to inspect subsequent activity.",
        inputSchema: mcpSendChatMessageInputSchema,
        outputSchema: mcpSendChatMessageOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      (input, context) => {
        return mutationTool(
          access,
          "okou:chat:send",
          (signal) => {
            return access.sendMessage(input, signal);
          },
          AbortSignal.any([requestSignal, context.mcpReq.signal]),
        );
      },
    );
  }
  if (access.scopes.includes("okou:run:cancel")) {
    server.registerTool(
      "revoke_queued_message",
      {
        description:
          "Withdraw an unclaimed queued input from your conversation using threadId and its original inputId (send_chat_message inputRef.eventId). Duplicate revocation is safe. Reserved or associated input cannot be withdrawn here; this never cancels a run. not_revocable does not prove delivery. Use cancel_run with the reported runId to stop execution when appropriate.",
        inputSchema: mcpRevokeQueuedMessageInputSchema,
        outputSchema: mcpRevokeQueuedMessageOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (input, context) => {
        return mutationTool(
          access,
          "okou:run:cancel",
          (signal) => {
            return access.revokeQueuedMessage(input, signal);
          },
          AbortSignal.any([requestSignal, context.mcpReq.signal]),
        );
      },
    );
    server.registerTool(
      "cancel_run",
      {
        description:
          "Cooperatively cancel your active run in the authorized organization. Duplicate cancellation is safe. The result records cancellation; worker interruption and cleanup may finish afterward. This does not revoke separate queued inputs or undo effects already performed. Completed or failed runs cannot be cancelled.",
        inputSchema: mcpCancelRunInputSchema,
        outputSchema: mcpCancelRunOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      (input, context) => {
        return mutationTool(
          access,
          "okou:run:cancel",
          (signal) => {
            return access.cancelRun(input, signal);
          },
          AbortSignal.any([requestSignal, context.mcpReq.signal]),
        );
      },
    );
  }
}

function createChatServer(
  access: McpChatAccess,
  requestSignal: AbortSignal,
): McpServer {
  const server = new McpServer(
    { name: "okou", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
  );
  if (access.scopes.includes(access.readScope)) {
    registerMessageTool(server, access, requestSignal);
    server.registerTool(
      "search_chat_messages",
      {
        description:
          "Search visible message text in your conversations in the authorized organization. " +
          "Use whole words or CJK phrases of at least two characters; all query groups must match. " +
          "Filter by threadId, agentId, role and source-event since (inclusive)/before (exclusive). " +
          "Returns newest source events first, bounded excerpts and real ref identifiers; pass a ref's " +
          "threadId and around:{eventId,seqId} to get_chat_messages for context and full content. " +
          "Follow nextCursor with the identical query, filters and limit (default 20, maximum 50). " +
          "An empty page may still have a nextCursor: scanLimited means the 100-candidate scan budget " +
          "was reached. Indexing is asynchronous; use get_chat_messages for recently sent content. " +
          "An empty search does not prove absence or send failure. Restart to refresh. Search does not mark messages " +
          "read. Canonical validation shares a 32 MiB/50,000-event/15-second history budget across " +
          "candidate threads; resource/archive failures are explicit errors, not partial successes.",
        inputSchema: mcpSearchChatMessagesInputSchema,
        outputSchema: mcpSearchChatMessagesOutputSchema,
        annotations: readAnnotations,
      },
      async (args, context) => {
        const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
        return await readTool(
          access,
          () => {
            return access.searchMessages(args, signal);
          },
          signal,
          "Message search is temporarily unavailable. Retry or narrow the thread, Agent or time filters.",
        );
      },
    );
    server.registerTool(
      "list_chat_threads",
      {
        description:
          "Find your conversations in the authorized organization, newest message first. " +
          "Filter by Agent, literal title substring, last-message since (inclusive)/before (exclusive), " +
          "activity or unread. Follow nextCursor with the same filters. Pagination reads live metadata; " +
          "restart to refresh conversations that move while paging. Unread covers retained terminal " +
          "events and native deliveries, not all archived history. Activity is not run completion. " +
          "Reading does not mark conversations read. Use get_chat_thread to inspect one result.",
        inputSchema: mcpListChatThreadsInputSchema,
        outputSchema: mcpListChatThreadsOutputSchema,
        annotations: readAnnotations,
      },
      async (args, context) => {
        const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
        return await readTool(
          access,
          () => {
            return access.listThreads(args, signal);
          },
          signal,
        );
      },
    );
    server.registerTool(
      "get_chat_thread",
      {
        description:
          "Read a conversation's current title, Agent, selected/effective model, activity and unread " +
          "state by threadId. Only your conversations in the authorized organization are accessible. " +
          "Model metadata describes current policy; actual run admission is checked when sending. " +
          "Unread covers retained terminal events and native deliveries. This does not read messages " +
          "or mark the conversation read, and idle activity does not establish execution success.",
        inputSchema: mcpGetChatThreadInputSchema,
        outputSchema: mcpGetChatThreadOutputSchema,
        annotations: readAnnotations,
      },
      async (args, context) => {
        const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
        return await readTool(
          access,
          () => {
            return access.getThread(args, signal);
          },
          signal,
        );
      },
    );
  }
  registerMutationTools(server, access, requestSignal);
  return server;
}

/** SDK types and per-request transport state remain within this gateway. */
export async function serveMcpRequest(
  request: Request,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): Promise<Response> {
  const handler = createMcpHandler(
    () => {
      return createChatServer(access, requestSignal);
    },
    {
      legacy: "stateless",
      responseMode: "auto",
      maxSubscriptions: 0,
    },
  );
  const response = await onRejection(handler.fetch(request), () => {
    return handler.close();
  });
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  if (!response.body) {
    await handler.close();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  // Returning the Response does not mean an SSE exchange has finished. Keep
  // its SDK owner alive until the body is consumed or cancelled by the host.
  const reader = response.body.getReader();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await settleIncludingAbort(reader.read());
      if (cancelled) {
        return;
      }
      if (!next.ok) {
        await handler.close();
        if (!cancelled) {
          controller.error(next.error);
        }
        return;
      }
      if (next.value.done) {
        await handler.close();
        if (!cancelled) {
          controller.close();
        }
      } else {
        controller.enqueue(next.value.value);
      }
    },
    async cancel(reason) {
      cancelled = true;
      const result = await settleIncludingAbort(reader.cancel(reason));
      await handler.close();
      if (!result.ok) {
        throw result.error;
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
