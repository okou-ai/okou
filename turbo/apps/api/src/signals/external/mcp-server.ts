import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type ServerContext,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import {
  mcpCreateChatThreadInputSchema,
  mcpCreateChatThreadOutputSchema,
  type McpCreateChatThreadInput,
  type McpCreateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-creation";
import {
  mcpUpdateChatThreadInputSchema,
  mcpUpdateChatThreadOutputSchema,
  type McpUpdateChatThreadInput,
  type McpUpdateChatThreadOutput,
} from "@okouai/api-contracts/contracts/mcp-chat-thread-update";
import {
  mcpListAgentsInputSchema,
  mcpListAgentsOutputSchema,
  mcpListModelsInputSchema,
  mcpListModelsOutputSchema,
  type McpListAgentsInput,
  type McpListAgentsOutput,
  type McpListModelsOutput,
  type McpDiscoveryResult,
} from "@okouai/api-contracts/contracts/mcp-chat-discovery";
import {
  mcpGetChatStatusInputSchema,
  mcpGetChatStatusOutputSchema,
  type McpGetChatStatusInput,
  type McpChatStatusResult,
} from "@okouai/api-contracts/contracts/mcp-chat-status";
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
import {
  MCP_TOOL_ERROR_MAX_ISSUES,
  MCP_TOOL_ERROR_MAX_PATH_SEGMENTS,
  type McpToolError,
} from "@okouai/api-contracts/contracts/mcp-tool-errors";
import { z } from "zod";
import { onRejection, settle, settleIncludingAbort } from "../utils";

interface McpChatAccess {
  readonly readScope: string;
  readonly scopes: readonly string[];
  readonly listAgents: (
    input: McpListAgentsInput,
    signal: AbortSignal,
  ) => Promise<McpDiscoveryResult<McpListAgentsOutput>>;
  readonly listModels: (
    signal: AbortSignal,
  ) => Promise<McpDiscoveryResult<McpListModelsOutput>>;
  readonly createThread: (
    input: McpCreateChatThreadInput,
    signal: AbortSignal,
  ) => Promise<McpChatMutationResult<McpCreateChatThreadOutput>>;
  readonly updateThread: (
    input: McpUpdateChatThreadInput,
    signal: AbortSignal,
  ) => Promise<McpChatMutationResult<McpUpdateChatThreadOutput>>;
  readonly getStatus: (
    input: McpGetChatStatusInput,
    signal: AbortSignal,
  ) => Promise<McpChatStatusResult>;
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

function toolError(error: McpToolError): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: { error },
  };
}

function validationToolError(
  toolName: string,
  error: z.ZodError,
): CallToolResult {
  const issues = error.issues
    .slice(0, MCP_TOOL_ERROR_MAX_ISSUES)
    .map((issue) => {
      return {
        path: issue.path
          .slice(0, MCP_TOOL_ERROR_MAX_PATH_SEGMENTS)
          .map((segment) => {
            return typeof segment === "number"
              ? segment
              : String(segment).slice(0, 256);
          }),
        code: issue.code,
        message: issue.message.slice(0, 1000),
      };
    });
  const detail = issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join(", ");
  return toolError({
    code: "invalid_arguments",
    message:
      `Input validation error: Invalid arguments for tool ${toolName}: ${detail}`.slice(
        0,
        4096,
      ),
    retryable: false,
    issues,
  });
}

function uncheckedInputSchema<Input extends Record<string, unknown>>(
  schema: z.ZodType<Input>,
): StandardSchemaWithJSON<unknown, unknown> {
  const advertised = schema as unknown as StandardSchemaWithJSON<
    unknown,
    Input
  >;
  return {
    "~standard": {
      version: 1,
      vendor: "okou",
      validate(value) {
        return { value };
      },
      jsonSchema: advertised["~standard"].jsonSchema,
    },
  };
}

interface ChatToolConfig<
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
> {
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly annotations?: ToolAnnotations;
}

function registerChatTool<
  InputSchema extends z.ZodType<Record<string, unknown>>,
  OutputSchema extends z.ZodType<Record<string, unknown>>,
>(
  server: McpServer,
  name: string,
  config: ChatToolConfig<InputSchema, OutputSchema>,
  callback: (
    input: z.output<InputSchema>,
    context: ServerContext,
  ) => CallToolResult | Promise<CallToolResult>,
): void {
  const { inputSchema, ...advertisedConfig } = config;
  server.registerTool(
    name,
    {
      ...advertisedConfig,
      inputSchema: uncheckedInputSchema(inputSchema),
    },
    async (input, context) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return validationToolError(name, parsed.error);
      }
      return await callback(parsed.data, context);
    },
  );
}

function retryableReadError(code: string): boolean {
  return (
    code === "unavailable" ||
    code === "view_changed" ||
    code.endsWith("_unavailable")
  );
}

async function readTool<T extends Record<string, unknown>>(
  access: McpChatAccess,
  operation: () => Promise<
    | { readonly kind: "ok"; readonly data: T }
    | { readonly kind: string; readonly message: string }
  >,
  signal: AbortSignal,
  unavailableMessage = "Thread information is temporarily unavailable. Retry, or narrow the Agent/time filters for a large search.",
): Promise<CallToolResult> {
  if (!access.scopes.includes(access.readScope)) {
    return toolError({
      code: "insufficient_scope",
      message: "Insufficient scope",
      retryable: false,
    });
  }
  signal.throwIfAborted();
  const result = await settle(operation(), signal);
  if (!result.ok) {
    return toolError({
      code: "unavailable",
      message: unavailableMessage,
      retryable: true,
    });
  }
  if (!("data" in result.value)) {
    return toolError({
      code: result.value.kind,
      message: result.value.message,
      retryable: retryableReadError(result.value.kind),
    });
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
  registerChatTool(
    server,
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
  unavailableMessage = "The operation result is unavailable. For sends, retry the identical requestId, threadId and text within 24 hours; otherwise inspect the current state before retrying.",
): Promise<CallToolResult> {
  if (!access.scopes.includes(scope)) {
    return toolError({
      code: "insufficient_scope",
      message: "Insufficient scope",
      retryable: false,
    });
  }
  requestSignal.throwIfAborted();
  const result = await settle(operation(requestSignal), requestSignal);
  if (!result.ok) {
    return toolError({
      code: "unavailable",
      message: unavailableMessage,
      retryable: true,
    });
  }
  if (result.value.kind === "error") {
    return toolError({
      code: result.value.code,
      message: result.value.message,
      retryable: result.value.retryable,
    });
  }
  return {
    structuredContent: result.value.data,
    content: [
      { type: "text" as const, text: JSON.stringify(result.value.data) },
    ],
  };
}

function registerManageTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerChatTool(
    server,
    "create_chat_thread",
    {
      description:
        "Create an empty conversation in the authorized organization, without sending a message or starting a run. First use list_agents and list_models; supply an explicit visible agentId, nonblank title and selectable model. Generate one UUID requestId per intended conversation; retry with that same requestId and identical Agent, exact title and model within 24 hours of acceptance. Retry returns current settings without overwriting later edits. Deleted, expired or conflicting requests fail. Deduplication is not guaranteed beyond retained identity; never automatically retry an uncertain old request. The threadId is the requestId. Follow nextAction to send a message separately; actual run admission is checked on send.",
      inputSchema: mcpCreateChatThreadInputSchema,
      outputSchema: mcpCreateChatThreadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, context) => {
      return mutationTool(
        access,
        "okou:chat:manage",
        (signal) => {
          return access.createThread(input, signal);
        },
        AbortSignal.any([requestSignal, context.mcpReq.signal]),
        "Creation result is unavailable. Retry the identical requestId, Agent, exact title and model within 24 hours; inspect that threadId before creating new work. Never automatically retry an uncertain old request.",
      );
    },
  );
  registerChatTool(
    server,
    "update_chat_thread",
    {
      description:
        "Atomically update your conversation title and/or future-run model in the authorized organization. patch must contain title and/or model; omitted fields and unrelated service-tier, reasoning, media and browser settings stay unchanged. model:null clears the thread pin. A title update is manual and suppresses later automatic title generation. Model changes affect later runs only; steering an existing run keeps that run's model. Generate one UUID requestId per intended patch and retry only the identical threadId and exact field presence/values within 24 hours. Exact replay returns current state without restoring older settings. Conflicting or expired reuse fails; inspect get_chat_thread before making a new intended change, and never automatically retry an uncertain old request.",
      inputSchema: mcpUpdateChatThreadInputSchema,
      outputSchema: mcpUpdateChatThreadOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, context) => {
      return mutationTool(
        access,
        "okou:chat:manage",
        (signal) => {
          return access.updateThread(input, signal);
        },
        AbortSignal.any([requestSignal, context.mcpReq.signal]),
        "Update result is unavailable. Retry the identical requestId, threadId and exact patch within 24 hours; otherwise inspect get_chat_thread before making a new intended change.",
      );
    },
  );
}

function registerMutationTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  if (access.scopes.includes("okou:chat:manage")) {
    registerManageTools(server, access, requestSignal);
  }
  if (access.scopes.includes("okou:chat:send")) {
    registerChatTool(
      server,
      "send_chat_message",
      {
        description:
          "Submit text to your existing conversation in the authorized organization. The server may start a run, queue the input, or steer an active run. Generate a new UUID requestId for each intended message; retry only with identical threadId and exact text using that same requestId within 24 hours of acceptance. Deduplication is not guaranteed after that window; inspect history before intentionally submitting new work, and never automatically retry an uncertain old request. inputRef identifies the original submitted input, which can be replaced in visible history. disposition is the current observation, not proof of delivery or run success; runId may be null. Pass threadId and inputRef to get_chat_status, then use its get_chat_messages handoff to read output.",
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
    registerChatTool(
      server,
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
    registerChatTool(
      server,
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

function registerDiscoveryTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerChatTool(
    server,
    "list_agents",
    {
      description:
        "Discover Agents visible to you in the authorized organization, including the default Agent. Returns bounded descriptions, not instructions or configuration. Follow nextCursor with the same limit (default 20, maximum 50); response limits may shorten a page. Cursors expire after 24 hours and visibility is rechecked on every page. Use agentId with create_chat_thread.",
      inputSchema: mcpListAgentsInputSchema,
      outputSchema: mcpListAgentsOutputSchema,
      annotations: readAnnotations,
    },
    (input, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return readTool(
        access,
        () => {
          return access.listAgents(input, signal);
        },
        signal,
        "Agent discovery is temporarily unavailable. Retry later.",
      );
    },
  );
  registerChatTool(
    server,
    "list_models",
    {
      description:
        "Discover the current model catalog and your member/workspace default. selectable means the model can be configured; availability separately reports known plan, connection or reconnection requirements. available is metadata only: quota, credentials and admission are checked when sending. This read does not create or repair configuration. If setup is required after a plan change, open model settings and retry. Use a selectable model id with create_chat_thread.",
      inputSchema: mcpListModelsInputSchema,
      outputSchema: mcpListModelsOutputSchema,
      annotations: readAnnotations,
    },
    (_input, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return readTool(
        access,
        () => {
          return access.listModels(signal);
        },
        signal,
        "Model discovery is temporarily unavailable. Retry later.",
      );
    },
  );
}

function registerSearchAndStatusTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerChatTool(
    server,
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
  registerChatTool(
    server,
    "get_chat_status",
    {
      description:
        "Observe input delivery, run state and readable output separately in your conversation. " +
        "Pass threadId and the complete original inputRef returned by send_chat_message; without " +
        "inputRef, observes the latest run. Missing input associations never select another run. " +
        "queued/reserved/associated do not prove delivery; delivered means an acknowledged active " +
        "input, not model compliance. deliveryMode is launch/steer only with evidence, otherwise unknown. " +
        "Several inputs can share a run and its output. A terminal run may still have pending/partial " +
        "output, including cancellation recovery. ready means current materialized output is readable; " +
        "late output may still arrive. Follow the messages tool handoff for content and pagination. " +
        "Honor retryAfterMs and back off repeated polls. Original references survive live retention " +
        "through retained archives within the same 8 MiB gzip, 32 MiB history, 50,000-event and " +
        "15-second limits as get_chat_messages; absent linkage is unavailable and archive failures " +
        "are explicit errors. This immediate read does not mark read, change execution or cancel runs.",
      inputSchema: mcpGetChatStatusInputSchema,
      outputSchema: mcpGetChatStatusOutputSchema,
      annotations: readAnnotations,
    },
    async (args, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return await readTool(
        access,
        () => {
          return access.getStatus(args, signal);
        },
        signal,
        "Chat status is temporarily unavailable. Retry later.",
      );
    },
  );
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
    registerSearchAndStatusTools(server, access, requestSignal);
    registerDiscoveryTools(server, access, requestSignal);
    registerChatTool(
      server,
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
    registerChatTool(
      server,
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
