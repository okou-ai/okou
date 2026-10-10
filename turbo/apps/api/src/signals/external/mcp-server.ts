import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { agentsMainContract } from "@okouai/api-contracts/contracts/agents";
import { chatThreadActivitySummaryContract } from "@okouai/api-contracts/contracts/chat-thread-activity-summary";
import {
  chatEventNormalSendBodySchema,
  chatEventsContract,
  chatSearchContract,
  chatThreadEventsContract,
  chatThreadModelSelectionContract,
  chatThreadRenameContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
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

/** No response projection: only the MCP transport's content packaging differs. */
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
    async (input, context) => {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        return toolBody(
          requestValidationError(
            parsed.error.issues[0] ?? { path: [], message: "Bad request" },
          ),
          true,
        );
      }
      // Mutation background work retains the same caller lifetime as Web. The
      // SDK exchange signal can abort merely because its successful reply closes.
      const signal = annotations.readOnlyHint
        ? AbortSignal.any([requestSignal, context.mcpReq.signal])
        : requestSignal;
      const result = await operation(parsed.data, signal);
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
  return toolBody({ snapshot, ...page });
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
  return toolBody({ snapshot, ...page });
}

const activity = chatThreadActivitySummaryContract.summarize;
const rename = chatThreadRenameContract.rename;
const model = chatThreadModelSelectionContract.update;
const normal = chatEventNormalSendBodySchema.shape;
const sendInput = z
  .object({
    agentId: normal.agentId,
    prompt: normal.prompt,
    threadId: normal.threadId,
    model: normal.model,
    clientEventId: normal.clientEventId,
  })
  .strict();

function registerReadTools(
  server: McpServer,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): void {
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
      name: "get_chat_thread",
      scope: "okou:chat:read",
      description:
        "Get the organization conversation-list R2 snapshot pointer and one bounded Web lifecycle-event page. Omit sinceSeqId initially; continue with the last event's seqId when hasMore is true. Does not download or reconstruct the snapshot.",
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
        "Get one conversation's R2 snapshot pointer (null before compaction) and one bounded raw Web event-row page. Omit the cursor initially; continue with cursor.lastSeqId as sinceSeqId and cursor.lastEventId as sinceEventId. On 410, restart from a fresh snapshot. Does not download, decompress or reconstruct history.",
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
        "Search using the Web keyword, agentId and since parameters and return the Web results unchanged.",
      inputSchema: chatSearchContract.search.query,
      outputSchema: chatSearchContract.search.responses[200],
      annotations: readAnnotations,
      operation: (query, signal) => {
        return requestWebApi(
          access,
          chatSearchContract.search,
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
      description: "Get the Web active/unread conversation indicators.",
      inputSchema: emptyInput,
      outputSchema: chatThreadsContract.indicators.responses[200],
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
        "Request the existing Web public activity summary for id and runId.",
      inputSchema: activity.pathParams.extend(activity.body.shape),
      outputSchema: activity.responses[200],
      annotations: writeAnnotations,
      operation: ({ id, ...body }, signal) => {
        return requestWebApi(
          access,
          activity,
          { pathParams: { id }, body },
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
        "Rename id with the existing Web rename body. Returns no content on Web 204.",
      inputSchema: rename.pathParams.extend(rename.body.shape).strict(),
      annotations: writeAnnotations,
      operation: ({ id, ...body }, signal) => {
        return requestWebApi(
          access,
          rename,
          { pathParams: { id }, body },
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
        "Update id with the existing Web model-selection body, including its effort/tier/event semantics. Returns no content on Web 204.",
      inputSchema: model.pathParams.extend(model.body.shape).strict(),
      annotations: writeAnnotations,
      operation: ({ id, ...body }, signal) => {
        return requestWebApi(
          access,
          model,
          { pathParams: { id }, body },
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
        "Send plain text through POST /api/chat/events. Uses Web validation and enqueue semantics and returns the Web response; it does not wait for a Run.",
      inputSchema: sendInput,
      outputSchema: chatEventsContract.send.responses[201],
      annotations: writeAnnotations,
      operation: (input, signal) => {
        return requestWebApi(
          access,
          chatEventsContract.send,
          {
            body: {
              ...input,
              userMessage: {
                version: 1,
                parts: [{ type: "text", text: input.prompt }],
              },
              hasTextContent: true,
            },
          },
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
      name: "revoke_queued_message",
      scope: "okou:run:cancel",
      description:
        "Append the ordinary Web recall event using revokesEventId directly. No original-input lookup or before/after state checks.",
      inputSchema: chatEventsContract.send.body.options[1],
      outputSchema: chatEventsContract.send.responses[201],
      annotations: { ...writeAnnotations, destructiveHint: true },
      operation: (body, signal) => {
        return requestWebApi(access, chatEventsContract.send, { body }, signal);
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
        "Cancel id through POST /api/runs/:id/cancel, with Web ownership, response and cancellation side effects.",
      inputSchema: runsCancelContract.cancel.pathParams,
      outputSchema: runsCancelContract.cancel.responses[200],
      annotations: { ...writeAnnotations, destructiveHint: true },
      operation: (pathParams, signal) => {
        return requestWebApi(
          access,
          runsCancelContract.cancel,
          { pathParams },
          signal,
        );
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
