import { randomUUID } from "node:crypto";
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { chatInputStatusContract } from "@okouai/api-contracts/contracts/chat-input-status";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import {
  chatEventsContract,
  chatThreadEventsContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { mcpChatSearchContract } from "@okouai/api-contracts/contracts/mcp-chat-search";
import {
  mcpCancelRunInputSchema,
  mcpCancelRunOutputSchema,
  mcpGetChatActivitySummaryInputSchema,
  mcpGetChatActivitySummaryOutputSchema,
  mcpGetChatIndicatorsOutputSchema,
  mcpRenameChatThreadInputSchema,
  mcpRevokeQueuedMessageInputSchema,
  mcpRevokeQueuedMessageOutputSchema,
  mcpSendChatMessageInputSchema,
  mcpSendChatMessageOutputSchema,
  mcpUpdateChatThreadModelInputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-tools";
import {
  mcpGetChatMessagesInputSchema,
  mcpGetChatMessagesOutputSchema,
  mcpGetChatThreadInputSchema,
  mcpGetChatThreadOutputSchema,
} from "@okouai/api-contracts/contracts/mcp-chat-snapshots";
import { runModelsMainContract } from "@okouai/api-contracts/contracts/run-models";
import { runsCancelContract } from "@okouai/api-contracts/contracts/run-routes";
import type { AppRoute } from "@okouai/api-contracts/contracts/trpc-contract";
import { z } from "zod";
import { requestValidationError } from "@okouai/api-contracts/contracts/errors";
import { onRejection, settleIncludingAbort } from "../utils";

interface McpChatAccess {
  readonly scopes: readonly string[];
  readonly requestWebApi: (
    request: Request,
    signal: AbortSignal,
  ) => Promise<Response>;
}

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});
const writeAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
});
const emptyInput = z.object({});

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

function mapJsonSchemaChildren(
  schema: Record<string, unknown>,
  map: (child: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schema).map(([keyword, value]) => {
      if (
        schemaMapKeywords.some((name) => {
          return name === keyword;
        }) &&
        isJsonObject(value)
      ) {
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
        schemaArrayKeywords.some((name) => {
          return name === keyword;
        }) &&
        Array.isArray(value)
      ) {
        return [
          keyword,
          value.map((child) => {
            return isJsonObject(child) ? map(child) : child;
          }),
        ];
      }
      if (
        schemaValueKeywords.some((name) => {
          return name === keyword;
        })
      ) {
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

/** The MCP SDK requires self-contained JSON Schemas at the transport boundary. */
function inlineJsonSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  function resolve(reference: string): Record<string, unknown> {
    if (!reference.startsWith("#/")) {
      throw new Error(`Unsupported JSON Schema reference ${reference}`);
    }
    let value: unknown = schema;
    for (const encoded of reference.slice(2).split("/")) {
      const segment = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
      const property = isJsonObject(value)
        ? Object.getOwnPropertyDescriptor(value, segment)
        : undefined;
      if (!property || !("value" in property)) {
        throw new Error(`Unresolved JSON Schema reference ${reference}`);
      }
      value = property.value;
    }
    if (!isJsonObject(value)) {
      throw new Error(`JSON Schema reference is not an object ${reference}`);
    }
    return value;
  }
  function inline(
    value: Record<string, unknown>,
    active: ReadonlySet<string>,
  ): Record<string, unknown> {
    if ("$ref" in value) {
      const reference = value.$ref;
      if (typeof reference !== "string" || active.has(reference)) {
        throw new Error("Unsupported or cyclic JSON Schema reference");
      }
      const siblings = { ...value };
      delete siblings.$ref;
      return {
        ...inline(resolve(reference), new Set(active).add(reference)),
        ...inline(siblings, active),
      };
    }
    const result = mapJsonSchemaChildren(value, (child) => {
      return inline(child, active);
    });
    delete result.$defs;
    delete result.definitions;
    return result;
  }
  return inline(schema, new Set());
}

const unsupportedJsonTypes: ReadonlySet<string> = Object.freeze(
  new Set([
    "bigint",
    "symbol",
    "date",
    "map",
    "set",
    "transform",
    "custom",
    "nan",
    "void",
    "function",
    "promise",
  ]),
);

function assertJsonRepresentable(type: string): void {
  if (unsupportedJsonTypes.has(type)) {
    throw new Error(
      `Web schema type ${type} cannot be represented in MCP JSON`,
    );
  }
}

function inlineZodSchema<Schema extends z.ZodType>(
  schema: Schema,
): StandardSchemaWithJSON<z.input<Schema>, z.output<Schema>> {
  const standard = (
    schema as unknown as StandardSchemaWithJSON<
      z.input<Schema>,
      z.output<Schema>
    >
  )["~standard"];
  return {
    "~standard": {
      version: 1,
      vendor: "okou",
      validate: (value) => {
        return standard.validate(value);
      },
      jsonSchema: {
        input: (options) => {
          return inlineJsonSchema(
            z.toJSONSchema(schema, {
              target: options.target,
              io: "input",
              unrepresentable: "any",
              override: ({ zodSchema, jsonSchema }) => {
                assertJsonRepresentable(zodSchema._zod.def.type);
                // Undefined has no JSON value: an optional undefined field must
                // be absent, not advertised as an unconstrained property.
                if (zodSchema._zod.def.type === "undefined") {
                  jsonSchema.not = {};
                }
                if (
                  (zodSchema instanceof z.ZodNumber && zodSchema.def.coerce) ||
                  (zodSchema instanceof z.ZodPipe &&
                    zodSchema.in instanceof z.ZodNumber &&
                    zodSchema.in.def.coerce)
                ) {
                  const normalized = z.toJSONSchema(zodSchema, {
                    target: options.target,
                    io: "output",
                  });
                  delete normalized.$schema;
                  Object.assign(jsonSchema, normalized);
                }
              },
            }),
          );
        },
        output: (options) => {
          return inlineJsonSchema(
            z.toJSONSchema(schema, {
              target: options.target,
              io: "output",
              unrepresentable: "any",
              override: ({ zodSchema, jsonSchema }) => {
                assertJsonRepresentable(zodSchema._zod.def.type);
                if (zodSchema._zod.def.type === "undefined") {
                  jsonSchema.not = {};
                }
              },
            }),
          );
        },
      },
    },
  };
}

function uncheckedInputSchema<Input extends Record<string, unknown>>(
  schema: z.ZodType<Input>,
): StandardSchemaWithJSON<unknown, unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: "okou",
      validate: (value) => {
        return { value };
      },
      jsonSchema: {
        input: (options) => {
          return {
            // Web URL-query coercion normalizes values before validation.
            // Advertise those JSON values, including paired-cursor constraints;
            // the original Web Zod schema still handles every invocation.
            ...inlineZodSchema(schema)["~standard"].jsonSchema.input(options),
            type: "object",
          };
        },
        output: (options) => {
          return {
            ...inlineZodSchema(schema)["~standard"].jsonSchema.output(options),
            type: "object",
          };
        },
      },
    },
  };
}

/** Package operation data in the MCP transport's content formats. */
function toolBody(body: unknown, isError = false): CallToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    ...(isJsonObject(body) ? { structuredContent: body } : {}),
    content:
      body === undefined ? [] : [{ type: "text", text: JSON.stringify(body) }],
  };
}

async function toolResponse(response: Response): Promise<CallToolResult> {
  return toolBody(
    response.status === 204 ? undefined : await response.json(),
    !response.ok,
  );
}

interface WebRequestInput {
  readonly pathParams?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

async function requestWebApi(
  access: McpChatAccess,
  route: AppRoute,
  input: WebRequestInput,
  signal: AbortSignal,
): Promise<Response> {
  let path = route.path;
  for (const [name, value] of Object.entries(input.pathParams ?? {})) {
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  // This URL is dispatched in-process, never fetched over the network.
  const url = new URL(path, "https://okou.internal");
  for (const [name, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(name, String(value));
    }
  }
  const request = new Request(url, {
    method: route.method,
    signal,
    ...(input.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input.body),
        }),
  });
  return await access.requestWebApi(request, signal);
}

interface WebToolConfig<
  InputSchema extends z.ZodType<Record<string, unknown>>,
> {
  readonly name: string;
  readonly scope: string;
  readonly description: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: z.ZodType<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
  readonly operation: (
    input: z.output<InputSchema>,
    signal: AbortSignal,
  ) => Promise<Response | CallToolResult>;
}

function registerWebTool<
  InputSchema extends z.ZodType<Record<string, unknown>>,
>(
  server: McpServer,
  access: McpChatAccess,
  config: WebToolConfig<InputSchema>,
  requestSignal: AbortSignal,
): void {
  const {
    name,
    scope,
    description,
    inputSchema,
    outputSchema,
    annotations,
    operation,
  } = config;
  if (!access.scopes.includes(scope)) {
    return;
  }
  server.registerTool(
    name,
    {
      description,
      inputSchema: uncheckedInputSchema(inputSchema),
      ...(outputSchema ? { outputSchema: inlineZodSchema(outputSchema) } : {}),
      annotations,
    },
    async (input) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return toolBody(
          requestValidationError(
            parsed.error.issues[0] ?? { path: [], message: "Bad request" },
          ),
          true,
        );
      }
      const result = await operation(parsed.data, requestSignal);
      return result instanceof Response ? await toolResponse(result) : result;
    },
  );
}

async function getThreadSnapshot(
  access: McpChatAccess,
  input: z.output<typeof mcpGetChatThreadInputSchema>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const snapshotResponse = await requestWebApi(
    access,
    chatThreadsContract.snapshot,
    {},
    signal,
  );
  if (!snapshotResponse.ok) {
    return await toolResponse(snapshotResponse);
  }
  const snapshot = chatThreadsContract.snapshot.responses[200].parse(
    await snapshotResponse.json(),
  );
  const eventsResponse = await requestWebApi(
    access,
    chatThreadsContract.events,
    {
      query: {
        sinceSeqId: input.sinceSeqId ?? snapshot.latestSeqId ?? undefined,
      },
    },
    signal,
  );
  if (!eventsResponse.ok) {
    return await toolResponse(eventsResponse);
  }
  const page = chatThreadsContract.events.responses[200].parse(
    await eventsResponse.json(),
  );
  return toolBody({
    snapshot,
    ...page,
    events: page.events.map(({ id, chatThreadId, ...event }) => {
      return { ...event, eventId: id, threadId: chatThreadId };
    }),
  });
}

async function getMessageSnapshot(
  access: McpChatAccess,
  input: z.output<typeof mcpGetChatMessagesInputSchema>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  const pathParams = { threadId: input.threadId };
  const snapshotResponse = await requestWebApi(
    access,
    chatThreadEventsContract.snapshot,
    { pathParams },
    signal,
  );
  let snapshot: z.output<
    (typeof chatThreadEventsContract.snapshot.responses)[200]
  > | null = null;
  if (snapshotResponse.ok) {
    snapshot = chatThreadEventsContract.snapshot.responses[200].parse(
      await snapshotResponse.json(),
    );
  } else {
    const error: unknown = await snapshotResponse.json();
    if (
      snapshotResponse.status !== 404 ||
      !isJsonObject(error) ||
      !isJsonObject(error.error) ||
      error.error.code !== "CHAT_EVENT_SNAPSHOT_NOT_FOUND"
    ) {
      return toolBody(error, true);
    }
  }
  const cursor =
    input.sinceSeqId === undefined
      ? {
          sinceSeqId: snapshot?.lastSeqId ?? 0,
          sinceEventId: snapshot?.lastEventId ?? undefined,
        }
      : { sinceSeqId: input.sinceSeqId, sinceEventId: input.sinceEventId };
  const rowsResponse = await requestWebApi(
    access,
    chatThreadEventsContract.rows,
    {
      pathParams,
      query: { ...cursor, limit: input.limit },
    },
    signal,
  );
  if (!rowsResponse.ok) {
    return await toolResponse(rowsResponse);
  }
  const page = chatThreadEventsContract.rows.responses[200].parse(
    await rowsResponse.json(),
  );
  return toolBody({
    snapshot,
    ...page,
    rows: page.rows.map(({ id, chatThreadId, ...row }) => {
      return { ...row, eventId: id, threadId: chatThreadId };
    }),
  });
}

const activity = chatThreadActivitySummaryContract.summarize;
const rename = chatThreadRenameContract.rename;
const model = chatThreadModelSelectionContract.update;

function registerInputStatusTool(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerWebTool(
    server,
    access,
    {
      name: "get_chat_input_status",
      scope: "okou:chat:read",
      description: chatInputStatusContract.get.description,
      inputSchema: chatInputStatusContract.get.pathParams,
      outputSchema: chatInputStatusContract.get.responses[200],
      annotations: readAnnotations,
      operation: (pathParams, signal) => {
        return requestWebApi(
          access,
          chatInputStatusContract.get,
          { pathParams },
          signal,
        );
      },
    },
    requestSignal,
  );
}

function registerReadTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerInputStatusTool(server, access, requestSignal);
  registerWebTool(
    server,
    access,
    {
      name: "list_agents",
      scope: "okou:chat:read",
      description:
        "List agents using GET /api/agents. The JSON text is the unmodified Web response array.",
      inputSchema: emptyInput,
      annotations: readAnnotations,
      operation: (_input, signal) => {
        return requestWebApi(access, agentsMainContract.list, {}, signal);
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "list_models",
      scope: "okou:chat:read",
      description: "List available models using GET /api/run-models.",
      inputSchema: emptyInput,
      outputSchema: runModelsMainContract.list.responses[200],
      annotations: readAnnotations,
      operation: (_input, signal) => {
        return requestWebApi(access, runModelsMainContract.list, {}, signal);
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "get_chat_thread_list",
      scope: "okou:chat:read",
      description:
        "Get the current user's chat thread list in the authorized organization as an R2 snapshot pointer and one bounded page of lifecycle events, with canonical eventId and threadId references. Download the snapshot and apply lifecycle events to reconstruct the list; this tool does not return one individual thread or download or reconstruct the snapshot. Omit sinceSeqId initially; when hasMore is true, continue with the last event's seqId until all pages are read. Downloaded snapshots retain their native Web format.",
      inputSchema: mcpGetChatThreadInputSchema,
      outputSchema: mcpGetChatThreadOutputSchema,
      annotations: readAnnotations,
      operation: (input, signal) => {
        return getThreadSnapshot(access, input, signal);
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "get_chat_messages",
      scope: "okou:chat:read",
      description:
        "Get one conversation's R2 snapshot pointer (null before compaction) and one bounded raw event-row page with canonical eventId, threadId and nullable runId references. Event identities, replacement references, paired cursors and payloads keep their native meaning. Use the known threadId to check recent sends without relying on search. Omit the cursor initially; rows start after the snapshot boundary, or at zero when snapshot is null. To inspect archived events, download snapshot.url (gzip NDJSON); downloaded rows retain native Web format, including id and chatThreadId. While hasMore is true, continue with cursor.lastSeqId as sinceSeqId and cursor.lastEventId as sinceEventId. On 410, restart from a fresh snapshot. Does not download, decompress or reconstruct history.",
      inputSchema: mcpGetChatMessagesInputSchema,
      outputSchema: mcpGetChatMessagesOutputSchema,
      annotations: readAnnotations,
      operation: (input, signal) => {
        return getMessageSnapshot(access, input, signal);
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "search_chat_messages",
      scope: "okou:chat:read",
      description:
        "Search using keyword, agentId and optional since. since is an inclusive ISO 8601 datetime lower bound (matchedMessage.createdAt >= since), with seconds, at most three fractional digits, and a required Z or ±HH:MM timezone, for example 2026-10-12T08:02:50Z. Numeric timestamps are not accepted. Selects up to 500 scoped keyword candidates without ordering, then sorts only those candidates by time and returns at most 100 messages. It does not guarantee the newest matches across all history. Pagination is not supported, and no continuation cursor or completeness signal is returned. Fewer than 100 results do not prove that all matches have been found. Hits and matchedMessage expose threadId; matchedMessage.runId is nullable. Hits expose stable agentId and nullable canonical displayName matching list_agents, for currently visible Agents. The index updates asynchronously: recent messages may be missing even after a Run completes, and an empty result does not prove absence. No index freshness signal or lag bound is returned. To confirm a recent send, use get_chat_messages with its known threadId and inspect the snapshot and event pages; do not resend solely because search is empty.",
      inputSchema: mcpChatSearchContract.search.query,
      outputSchema: mcpChatSearchContract.search.responses[200],
      annotations: readAnnotations,
      operation: (query, signal) => {
        return requestWebApi(
          access,
          mcpChatSearchContract.search,
          { query },
          signal,
        );
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "get_chat_indicators",
      scope: "okou:chat:read",
      description:
        "Show active (pending/running) and unread (completed/failed/cancelled) indicators for visible Agents and threads. This limited, non-atomic list does not prove Run completion. Use get_chat_messages with the known threadId and check terminal events for the matching runId to confirm an outcome. Does not mark threads read.",
      inputSchema: emptyInput,
      outputSchema: mcpGetChatIndicatorsOutputSchema,
      annotations: readAnnotations,
      operation: (_input, signal) => {
        return requestWebApi(
          access,
          chatThreadsContract.indicators,
          {},
          signal,
        );
      },
    },
    requestSignal,
  );
}

function registerMetadataTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerWebTool(
    server,
    access,
    {
      name: "get_chat_activity_summary",
      scope: "okou:chat:read",
      description:
        "Request the existing Web public activity summary for threadId and runId.",
      inputSchema: mcpGetChatActivitySummaryInputSchema,
      outputSchema: mcpGetChatActivitySummaryOutputSchema,
      annotations: writeAnnotations,
      operation: ({ threadId, ...body }, signal) => {
        return requestWebApi(
          access,
          activity,
          { pathParams: { id: threadId }, body },
          signal,
        );
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "rename_chat_thread",
      scope: "okou:chat:manage",
      description:
        "Rename threadId with the existing Web rename body. Returns no content on Web 204.",
      inputSchema: mcpRenameChatThreadInputSchema,
      annotations: writeAnnotations,
      operation: ({ threadId, ...body }, signal) => {
        return requestWebApi(
          access,
          rename,
          { pathParams: { id: threadId }, body },
          signal,
        );
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "update_chat_thread_model",
      scope: "okou:chat:manage",
      description:
        "Update threadId with the existing Web model-selection body, including its effort/tier/event semantics. Returns no content on Web 204.",
      inputSchema: mcpUpdateChatThreadModelInputSchema,
      annotations: writeAnnotations,
      operation: ({ threadId, ...body }, signal) => {
        return requestWebApi(
          access,
          model,
          { pathParams: { id: threadId }, body },
          signal,
        );
      },
    },
    requestSignal,
  );
}

function registerMutationTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
  registerWebTool(
    server,
    access,
    {
      name: "send_chat_message",
      scope: "okou:chat:send",
      description:
        "Send plain text through POST /api/chat/events using Web validation and enqueue semantics. Generates and returns the accepted input's eventId with threadId and createdAt. Use eventId with revoke_queued_message to recall it while queued. Use get_chat_input_status with threadId and eventId for a bounded read of its retained Chat disposition and matching terminal event. Consumption alone does not prove completion. Does not wait for execution or provide safe retries after a lost acknowledgement.",
      inputSchema: mcpSendChatMessageInputSchema,
      outputSchema: mcpSendChatMessageOutputSchema,
      annotations: writeAnnotations,
      operation: async (input, signal) => {
        const eventId = randomUUID();
        const response = await requestWebApi(
          access,
          chatEventsContract.send,
          {
            body: {
              ...input,
              clientEventId: eventId,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: input.prompt }],
              },
              hasTextContent: true,
            },
          },
          signal,
        );
        if (!response.ok) {
          return await toolResponse(response);
        }
        const body: unknown = await response.json();
        signal.throwIfAborted();
        const accepted = chatEventsContract.send.responses[201].parse(body);
        return toolBody(
          mcpSendChatMessageOutputSchema.parse({ ...accepted, eventId }),
        );
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "revoke_queued_message",
      scope: "okou:run:cancel",
      description:
        "Recall the queued input identified by eventId through the ordinary Web recall event. Maps eventId to native revokesEventId; no original-input lookup or before/after state checks.",
      inputSchema: mcpRevokeQueuedMessageInputSchema,
      outputSchema: mcpRevokeQueuedMessageOutputSchema,
      annotations: { ...writeAnnotations, destructiveHint: true },
      operation: async ({ eventId, ...body }, signal) => {
        const response = await requestWebApi(
          access,
          chatEventsContract.send,
          { body: { ...body, revokesEventId: eventId } },
          signal,
        );
        if (!response.ok) {
          return await toolResponse(response);
        }
        const accepted = chatEventsContract.send.responses[201].parse(
          await response.json(),
        );
        signal.throwIfAborted();
        return toolBody(
          mcpRevokeQueuedMessageOutputSchema.parse({
            ...accepted,
            runId: null,
          }),
        );
      },
    },
    requestSignal,
  );
  registerWebTool(
    server,
    access,
    {
      name: "cancel_run",
      scope: "okou:run:cancel",
      description:
        "Cancel runId through POST /api/runs/:id/cancel, with Web ownership and cancellation side effects. Returns runId, status and message.",
      inputSchema: mcpCancelRunInputSchema,
      outputSchema: mcpCancelRunOutputSchema,
      annotations: { ...writeAnnotations, destructiveHint: true },
      operation: async ({ runId }, signal) => {
        const response = await requestWebApi(
          access,
          runsCancelContract.cancel,
          { pathParams: { id: runId } },
          signal,
        );
        if (!response.ok) {
          return await toolResponse(response);
        }
        const body: unknown = await response.json();
        signal.throwIfAborted();
        const { id, ...cancelled } =
          runsCancelContract.cancel.responses[200].parse(body);
        return toolBody({ ...cancelled, runId: id });
      },
    },
    requestSignal,
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
  registerReadTools(server, access, requestSignal);
  registerMetadataTools(server, access, requestSignal);
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
