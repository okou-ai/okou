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

const toolSummaryMaxBytes = 512;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const schemaMapKeywords = [
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;
const schemaArrayKeywords = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const schemaValueKeywords = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

function includesString(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

function mapJsonSchemaChildren(
  schema: Record<string, unknown>,
  map: (child: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([keyword, value]) => {
      if (includesString(schemaMapKeywords, keyword) && isJsonObject(value)) {
        return [
          keyword,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => {
              return [name, isJsonObject(child) ? map(child) : child];
            }),
          ),
        ];
      }
      if (
        includesString(schemaArrayKeywords, keyword) &&
        Array.isArray(value)
      ) {
        return [
          keyword,
          value.map((child) => {
            return isJsonObject(child) ? map(child) : child;
          }),
        ];
      }
      if (includesString(schemaValueKeywords, keyword)) {
        if (isJsonObject(value)) {
          return [keyword, map(value)];
        }
        if (Array.isArray(value)) {
          return [
            keyword,
            value.map((child) => {
              return isJsonObject(child) ? map(child) : child;
            }),
          ];
        }
      }
      return [keyword, value];
    }),
  );
}

function inlineJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  function resolve(reference: string): Record<string, unknown> {
    if (!reference.startsWith("#/")) {
      throw new Error(`Unsupported JSON Schema reference ${reference}`);
    }
    let value: unknown = schema;
    for (const encodedSegment of reference.slice(2).split("/")) {
      const segment = encodedSegment
        .replaceAll("~1", "/")
        .replaceAll("~0", "~");
      if (!isJsonObject(value) || !Object.hasOwn(value, segment)) {
        throw new Error(`Unresolved JSON Schema reference ${reference}`);
      }
      value = value[segment];
    }
    if (!isJsonObject(value)) {
      throw new Error(`JSON Schema reference is not an object ${reference}`);
    }
    return value;
  }

  function inline(
    value: Record<string, unknown>,
    activeReferences: ReadonlySet<string>,
  ): Record<string, unknown> {
    if ("$ref" in value) {
      const reference = value.$ref;
      if (typeof reference !== "string" || Object.keys(value).length !== 1) {
        throw new Error("Unsupported JSON Schema reference with siblings");
      }
      if (activeReferences.has(reference)) {
        throw new Error(`Cyclic JSON Schema reference ${reference}`);
      }
      return inline(
        resolve(reference),
        new Set(activeReferences).add(reference),
      );
    }
    const rewritten = mapJsonSchemaChildren(value, (child) => {
      return inline(child, activeReferences);
    });
    const result = { ...rewritten };
    delete result.$defs;
    delete result.definitions;
    return result;
  }

  return inline(schema, new Set());
}

function inlineStandardSchema<Input, Output>(
  schema: StandardSchemaWithJSON<Input, Output>,
): StandardSchemaWithJSON<Input, Output> {
  const standard = schema["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "okou",
      validate(value) {
        return standard.validate(value);
      },
      jsonSchema: {
        input(options) {
          return inlineJsonSchema(standard.jsonSchema.input(options));
        },
        output(options) {
          return inlineJsonSchema(standard.jsonSchema.output(options));
        },
      },
    },
  };
}

function inlineZodSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaWithJSON<z.input<Schema>, z.output<Schema>> {
  return inlineStandardSchema(
    schema as unknown as StandardSchemaWithJSON<
      z.input<Schema>,
      z.output<Schema>
    >,
  );
}

function toolSuccess<T extends Record<string, unknown>>(
  data: T,
  summary: string,
): CallToolResult {
  if (utf8Bytes(summary) > toolSummaryMaxBytes) {
    throw new Error("MCP tool summary exceeds 512 UTF-8 bytes");
  }
  return {
    structuredContent: data,
    content: [{ type: "text", text: summary }],
  };
}

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
  const advertised = inlineZodSchema(schema);
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
  const { inputSchema, outputSchema, ...advertisedConfig } = config;
  server.registerTool(
    name,
    {
      ...advertisedConfig,
      inputSchema: uncheckedInputSchema(inputSchema),
      outputSchema: inlineZodSchema(outputSchema),
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
  summarize: (data: T) => string,
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
  return toolSuccess(result.value.data, summarize(result.value.data));
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
        "Read visible messages in turn order (latest 20 by default). messageAt is accepted-input time for users and output-event time for assistants. Filter by runId or center the first page on eventId/seqId with around. Continue cursors with unchanged filters and no around; use nextContentCursor for truncated content. Offsets count UTF-16 units/files. History changes invalidate cursors. Reading does not mark read or bypass artifact authorization. Limits: 8 MiB gzip, 32 MiB decoded plus tail, 50,000 events, 15 seconds.",
      inputSchema: mcpGetChatMessagesInputSchema,
      outputSchema: mcpGetChatMessagesOutputSchema,
      annotations: { ...readAnnotations, title: "Read Chat Messages" },
    },
    async (args, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return await readTool(
        access,
        () => {
          return access.getMessages(args, signal);
        },
        signal,
        (data) => {
          const older = data.olderCursor
            ? "older messages available"
            : "oldest page";
          const newer = data.newerCursor
            ? "newer messages available"
            : "newest page";
          return `Read ${data.messages.length} message(s); ${older}; ${newer}.`;
        },
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
  options: {
    readonly summarize: (data: T) => string;
    readonly unavailableMessage?: string;
  },
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
      message:
        options.unavailableMessage ??
        "The operation result is unavailable. For sends, retry the identical requestId, threadId and text within 24 hours; otherwise inspect the current state before retrying.",
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
  return toolSuccess(result.value.data, options.summarize(result.value.data));
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
        "Create a conversation and optionally its first message atomically. requestId is required. Omitted agentId uses the visible organization default; omitted model pins the then-current default at first run admission; omitted title remains null until the first text run names it. Without message, use send_chat_message. With message, dispatch follows acceptance; use get_chat_status because acceptance is not delivery or success. Use one UUID requestId per intent. Within 24 hours, retry only the identical mode, values, and field presence; retryUntil is the deadline. Creation is not generally idempotent after expiry, so inspect current state. threadId equals requestId; inputRef is stable.",
      inputSchema: mcpCreateChatThreadInputSchema,
      outputSchema: mcpCreateChatThreadOutputSchema,
      annotations: {
        title: "Create Chat Thread",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, context) => {
      return mutationTool(
        access,
        "message" in input ? "okou:chat:send" : "okou:chat:manage",
        (signal) => {
          return access.createThread(input, signal);
        },
        AbortSignal.any([requestSignal, context.mcpReq.signal]),
        {
          summarize(data) {
            return `Created chat thread ${data.threadId}${data.replayed ? " (replayed request)" : ""}. Next: ${data.nextAction.tool}.`;
          },
          unavailableMessage:
            "Creation result is unavailable. Retry the identical requestId, mode, exact values and optional-field presence within 24 hours; inspect that threadId before creating new work. Never automatically retry an uncertain old request.",
        },
      );
    },
  );
  registerChatTool(
    server,
    "update_chat_thread",
    {
      description:
        "Update title and/or future-run model atomically; omitted fields stay unchanged. metadataUpdatedAt is the metadata clock, not lastMessageAt. model:null clears the pin; next run admission pins the then-current default. A title update suppresses automatic naming; model changes do not affect an active run. Use one UUID requestId per patch. For 24 hours, retry only the identical threadId and patch; retryUntil is the deadline. Updates are not generally idempotent after expiry; inspect current state. Replay returns current state without restoring older settings.",
      inputSchema: mcpUpdateChatThreadInputSchema,
      outputSchema: mcpUpdateChatThreadOutputSchema,
      annotations: {
        title: "Update Chat Thread",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
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
        {
          summarize(data) {
            return `Updated chat thread ${data.threadId}${data.replayed ? " (replayed request)" : ""}.`;
          },
          unavailableMessage:
            "Update result is unavailable. Retry the identical requestId, threadId and exact patch within 24 hours; otherwise inspect get_chat_thread before making a new intended change.",
        },
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
          "Submit text to an existing conversation; the server may launch, queue, or steer. Use a new UUID requestId per intended message. Within 24 hours, retry only the identical threadId and exact text; retryUntil is the deadline. Sends are not generally idempotent after expiry, so inspect history before new work. inputRef identifies the original input even if visible history replaces it. disposition is observational, not proof of delivery or success, and runId may be null. Execute nextAction unchanged to observe this input with get_chat_status, then follow its message handoff.",
        inputSchema: mcpSendChatMessageInputSchema,
        outputSchema: mcpSendChatMessageOutputSchema,
        annotations: {
          title: "Send Chat Message",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
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
          {
            summarize(data) {
              const run = data.runId
                ? `; run ${data.runId}`
                : "; no run assigned";
              return `Accepted chat input ${data.inputRef.eventId}; disposition ${data.disposition}${run}.`;
            },
          },
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
          "Withdraw an unclaimed queued input using the complete send_chat_message inputRef. Repeating a revocation is safe. Reserved or associated input is not revocable here, and not_revocable does not prove delivery. This never cancels a run; use cancel_run with the reported runId when appropriate.",
        inputSchema: mcpRevokeQueuedMessageInputSchema,
        outputSchema: mcpRevokeQueuedMessageOutputSchema,
        annotations: {
          title: "Revoke Queued Message",
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
          {
            summarize(data) {
              const run = data.runId ? `; run ${data.runId}` : "";
              return `Queued input ${data.inputRef.eventId}: ${data.outcome}${run}.`;
            },
          },
        );
      },
    );
    registerChatTool(
      server,
      "cancel_run",
      {
        description:
          "Cooperatively cancel an active run. Repeating cancellation is safe. The result records cancellation, while worker interruption and cleanup may finish later. This neither revokes separate queued inputs nor undoes prior effects. Completed or failed runs cannot be cancelled.",
        inputSchema: mcpCancelRunInputSchema,
        outputSchema: mcpCancelRunOutputSchema,
        annotations: {
          title: "Cancel Run",
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
          {
            summarize(data) {
              return `Run ${data.runId} is cancelled${data.alreadyCancelled ? " (already cancelled)" : ""}.`;
            },
          },
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
        "List visible Agents, including the default, with bounded descriptions rather than instructions/configuration. Continue nextCursor with the same limit (default 20, max 50); pages may be shortened by response limits. Cursors expire after 24 hours and visibility is rechecked per page. Use agentId with create_chat_thread.",
      inputSchema: mcpListAgentsInputSchema,
      outputSchema: mcpListAgentsOutputSchema,
      annotations: { ...readAnnotations, title: "List Agents" },
    },
    (input, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return readTool(
        access,
        () => {
          return access.listAgents(input, signal);
        },
        signal,
        (data) => {
          return `Found ${data.agents.length} visible Agent(s)${data.nextCursor ? "; more available" : "; end of list"}.`;
        },
        "Agent discovery is temporarily unavailable. Retry later.",
      );
    },
  );
  registerChatTool(
    server,
    "list_models",
    {
      description:
        "List the current model catalog and member/workspace default. selectable means configurable; availability reports known plan or connection requirements. available is metadata only: quota, credentials, and admission are checked on send. This read does not repair configuration; open model settings for required setup. Use a selectable model id with create_chat_thread.",
      inputSchema: mcpListModelsInputSchema,
      outputSchema: mcpListModelsOutputSchema,
      annotations: { ...readAnnotations, title: "List Models" },
    },
    (_input, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return readTool(
        access,
        () => {
          return access.listModels(signal);
        },
        signal,
        (data) => {
          const selectable = data.models.filter((model) => {
            return model.selectable;
          }).length;
          return `Found ${data.models.length} model(s), ${selectable} selectable; default ${data.defaultModel.model ?? "not configured"}.`;
        },
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
        "Search visible message text using whole words or CJK phrases of 2+ characters; every query group must match. Filter by thread, Agent, role, and sourceEventAt; bounds, newest-first order, and continuation all use that source-event clock. Results include bounded excerpts and real refs; use around with get_chat_messages for full context. Continue nextCursor with identical inputs (default 20, max 50). Empty pages may continue; scanLimited marks the 100-candidate budget. Indexing is asynchronous; empty results do not prove absence. Search does not mark read, and 32 MiB/50,000-event/15-second history limits fail explicitly.",
      inputSchema: mcpSearchChatMessagesInputSchema,
      outputSchema: mcpSearchChatMessagesOutputSchema,
      annotations: { ...readAnnotations, title: "Search Chat Messages" },
    },
    async (args, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return await readTool(
        access,
        () => {
          return access.searchMessages(args, signal);
        },
        signal,
        (data) => {
          const more = data.nextCursor ? "; more candidates available" : "";
          const limited = data.scanLimited ? "; scan limit reached" : "";
          return `Found ${data.matches.length} message match(es)${more}${limited}.`;
        },
        "Message search is temporarily unavailable. Retry or narrow the thread, Agent or time filters.",
      );
    },
  );
  registerChatTool(
    server,
    "get_chat_status",
    {
      description:
        "Observe derived lifecycle {phase,outcome,output}. Pass complete send_chat_message inputRef " +
        "for that input, or only threadId for the latest run. waitMs requires inputRef, clamps to " +
        "8 seconds and 5 observations, and returns ready, deadline, or status; " +
        "deadline or capacity is current state, not a run outcome. Missing associations never select " +
        "another run. queued proves neither delivery, provenance, nor model compliance. Private " +
        "observations may map several inputs to one run and output. Terminal runs may remain " +
        "finalizing with pending or partial output; ready means current materialized output is " +
        "readable, but late output may arrive. A ready wait includes one bounded messagePage; follow " +
        "its cursors or messages handoff. Disconnect cancels only the waiter, never the run. Honor " +
        "retryAfterMs. Limits match get_chat_messages: 8 MiB gzip, 32 MiB history, 50,000 events, " +
        "15 seconds; missing refs are unavailable and archive errors explicit. Response caps are " +
        "16 KiB, or 192 KiB with messagePage. Reading neither marks read nor changes or cancels " +
        "execution.",
      inputSchema: mcpGetChatStatusInputSchema,
      outputSchema: mcpGetChatStatusOutputSchema,
      annotations: { ...readAnnotations, title: "Get Chat Status" },
    },
    async (args, context) => {
      const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
      return await readTool(
        access,
        () => {
          return access.getStatus(args, signal);
        },
        signal,
        (data) => {
          const outcome = data.lifecycle.outcome
            ? `/${data.lifecycle.outcome}`
            : "";
          const wait = data.wait
            ? `; wait ${data.wait.outcome} (${data.wait.returnReason})`
            : "";
          const retry = data.retryAfterMs
            ? `; retry after ${data.retryAfterMs} ms`
            : "";
          return `Chat ${data.threadId}: ${data.lifecycle.phase}${outcome}/${data.lifecycle.output}${wait}${retry}.`;
        },
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
          "List your conversations newest-message first. Filter by Agent, literal title substring, lastMessageAt, activity, or unread; bounds, order, and continuation use lastMessageAt, while metadataUpdatedAt is the separate metadata clock. Continue nextCursor with identical filters. Pagination reads live metadata, so restart to refresh moved conversations. Unread covers retained terminal events and native deliveries, not all archives; activity is not run completion. Reading does not mark read. Use get_chat_thread for details.",
        inputSchema: mcpListChatThreadsInputSchema,
        outputSchema: mcpListChatThreadsOutputSchema,
        annotations: { ...readAnnotations, title: "List Chat Threads" },
      },
      async (args, context) => {
        const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
        return await readTool(
          access,
          () => {
            return access.listThreads(args, signal);
          },
          signal,
          (data) => {
            return `Found ${data.threads.length} chat thread(s)${data.nextCursor ? "; more available" : "; end of list"}.`;
          },
        );
      },
    );
    registerChatTool(
      server,
      "get_chat_thread",
      {
        description:
          "Read one owned conversation's title, Agent, selected/effective model, activity, and unread state. createdAt is creation, metadataUpdatedAt is metadata change, and lastMessageAt is message activity. Model metadata is current policy; admission is checked on send. Unread covers retained terminal events and native deliveries. This neither reads messages nor marks read, and idle activity does not prove execution success.",
        inputSchema: mcpGetChatThreadInputSchema,
        outputSchema: mcpGetChatThreadOutputSchema,
        annotations: { ...readAnnotations, title: "Get Chat Thread" },
      },
      async (args, context) => {
        const signal = AbortSignal.any([requestSignal, context.mcpReq.signal]);
        return await readTool(
          access,
          () => {
            return access.getThread(args, signal);
          },
          signal,
          (data) => {
            return `Read chat thread ${data.thread.threadId}.`;
          },
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
