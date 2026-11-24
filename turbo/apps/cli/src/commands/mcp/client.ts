import {
  Client,
  InsufficientScopeError,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type JSONObject,
  type Tool,
} from "@modelcontextprotocol/client";
import {
  mcpOAuthScopeListSchema,
  type McpConnector,
} from "@okouai/api-contracts/contracts/mcp-connectors";

import { reauthorizeRunMcpConnectorOAuth } from "../../lib/api/domains/connectors";
import { ApiRequestError } from "../../lib/api/core/client-factory";

declare const __CLI_VERSION__: string;

const CONNECTOR_INTENT_HEADER = "X-Okou-Connector-Intent";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 8 * 1024;
const MAX_DISCOVERY_BYTES = 16 * 1024 * 1024;
const MAX_DISCOVERY_PAGES = 100;
const MAX_DISCOVERY_TOOLS = 2_000;

export type McpCallFailureKind = "client" | "protocol" | "transport";

export class McpCallFailure extends Error {
  constructor(
    readonly kind: McpCallFailureKind,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

class McpCommandError extends McpCallFailure {
  constructor(code: string, message: string) {
    super("client", code, message, false);
  }
}

class McpDeadlineError extends Error {}

class McpResponseLimitError extends McpCommandError {
  constructor(message: string) {
    super("response_limit", message);
  }
}

interface McpOperationResult<T> {
  readonly value: T;
  readonly cleanupWarning: boolean;
}

function cancelResponse(response: Response, reason: Error): void {
  if (response.body) {
    void response.body.cancel(reason).catch(() => {
      return undefined;
    });
  }
}

function contentLengthExceeds(response: Response, limit: number): boolean {
  const value = response.headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) {
    return false;
  }
  const length = Number(value);
  return Number.isSafeInteger(length) && length > limit;
}

function limitResponse(response: Response): Response {
  const limit = response.ok ? MAX_RESPONSE_BYTES : MAX_ERROR_RESPONSE_BYTES;
  if (contentLengthExceeds(response, limit)) {
    const error = new McpResponseLimitError(
      response.ok
        ? "MCP response exceeds the 16 MiB limit"
        : "MCP server error response exceeds the 8 KiB limit",
    );
    cancelResponse(response, error);
    throw error;
  }

  if (response.body === null) {
    return response;
  }

  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }

      receivedBytes += next.value.byteLength;
      if (receivedBytes > limit) {
        const error = new McpResponseLimitError(
          response.ok
            ? "MCP response exceeds the 16 MiB limit"
            : "MCP server error response exceeds the 8 KiB limit",
        );
        await reader.cancel(error).catch(() => {
          return undefined;
        });
        controller.error(error);
        return;
      }
      controller.enqueue(next.value);
    },
    async cancel(reason: unknown) {
      await reader.cancel(reason);
    },
  });

  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function createMcpFetch(
  connectorId: string,
  deadlineSignal: AbortSignal,
): FetchLike {
  return async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set(CONNECTOR_INTENT_HEADER, connectorId);
    const request = new Request(url, {
      ...init,
      headers,
      redirect: "error",
    });
    const signal = AbortSignal.any([request.signal, deadlineSignal]);
    const response = await globalThis.fetch(request, { signal });
    return limitResponse(response);
  };
}

function remainingMilliseconds(deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new McpDeadlineError("MCP command timed out");
  }
  return remaining;
}

function requestOptions(
  deadlineAt: number,
  deadlineSignal: AbortSignal,
): {
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxTotalTimeout: number;
} {
  const remaining = remainingMilliseconds(deadlineAt);
  return {
    signal: deadlineSignal,
    timeout: remaining,
    maxTotalTimeout: remaining,
  };
}

async function closeMcpClient(
  client: Client,
  transport: StreamableHTTPClientTransport,
): Promise<boolean> {
  let cleanupWarning = false;
  if (transport.sessionId !== undefined) {
    try {
      await transport.terminateSession();
    } catch {
      cleanupWarning = true;
    }
  }

  try {
    await client.close();
  } catch {
    cleanupWarning = true;
  }
  return cleanupWarning;
}

function parseRequiredScopes(error: InsufficientScopeError): string[] | null {
  if (!error.requiredScope) {
    return null;
  }
  const scopes = [
    ...new Set(error.requiredScope.split(/\s+/u).filter(Boolean)),
  ];
  const parsed = mcpOAuthScopeListSchema.safeParse(scopes);
  return parsed.success ? parsed.data : null;
}

async function insufficientScopeError(
  connector: McpConnector,
  error: InsufficientScopeError,
  deadlineSignal: AbortSignal,
): Promise<McpCallFailure> {
  const scopes = parseRequiredScopes(error);
  if (!scopes) {
    return new McpCallFailure(
      "transport",
      "insufficient_scope",
      "MCP server request failed",
      false,
    );
  }
  try {
    const authorization = await reauthorizeRunMcpConnectorOAuth(
      connector.target,
      scopes,
      deadlineSignal,
    );
    return new McpCallFailure(
      "transport",
      "insufficient_scope",
      [
        "This MCP connector needs additional authorization for future runs:",
        `[Authorize MCP connector](${authorization.authorizationUrl})`,
        ...(authorization.kind === "oauth"
          ? [`This link expires at ${authorization.expiresAt}.`]
          : []),
        "The failed MCP request was not retried. Start a new run after authorization.",
      ].join("\n"),
      false,
    );
  } catch (reauthorizationError) {
    if (reauthorizationError instanceof ApiRequestError) {
      return new McpCallFailure(
        "transport",
        "reauthorization_failed",
        `MCP scope reauthorization failed: ${reauthorizationError.message}. The failed MCP request was not retried.`,
        false,
      );
    }
    return new McpCallFailure(
      "transport",
      "reauthorization_failed",
      "MCP server request failed",
      false,
    );
  }
}

function protocolErrorCode(code: number): string {
  switch (code) {
    case ProtocolErrorCode.ParseError:
      return "parse_error";
    case ProtocolErrorCode.InvalidRequest:
      return "invalid_request";
    case ProtocolErrorCode.MethodNotFound:
      return "method_not_found";
    case ProtocolErrorCode.InvalidParams:
      return "invalid_params";
    case ProtocolErrorCode.InternalError:
      return "internal_error";
    case ProtocolErrorCode.ResourceNotFound:
      return "resource_not_found";
    case ProtocolErrorCode.MissingRequiredClientCapability:
      return "missing_required_client_capability";
    case ProtocolErrorCode.UnsupportedProtocolVersion:
      return "unsupported_protocol_version";
    case ProtocolErrorCode.UrlElicitationRequired:
      return "url_elicitation_required";
    default:
      return "protocol_error";
  }
}

function sdkErrorCode(code: SdkErrorCode): string {
  return code.toLowerCase();
}

async function safeMcpError(
  connector: McpConnector,
  error: unknown,
  deadlineSignal: AbortSignal,
  deadlineAt: number,
  timeoutSeconds: number,
): Promise<McpCallFailure> {
  if (
    deadlineSignal.aborted ||
    Date.now() >= deadlineAt ||
    error instanceof McpDeadlineError
  ) {
    return new McpCallFailure(
      "transport",
      "timeout",
      `MCP command timed out after ${timeoutSeconds}s`,
      false,
    );
  }
  if (error instanceof InsufficientScopeError) {
    const reauthorizationError = await insufficientScopeError(
      connector,
      error,
      deadlineSignal,
    );
    return deadlineSignal.aborted || Date.now() >= deadlineAt
      ? new McpCallFailure(
          "transport",
          "timeout",
          `MCP command timed out after ${timeoutSeconds}s`,
          false,
        )
      : reauthorizationError;
  }
  if (error instanceof McpCommandError) {
    return error;
  }
  if (error instanceof ProtocolError) {
    return new McpCallFailure(
      "protocol",
      protocolErrorCode(error.code),
      "MCP server returned a protocol error",
      false,
    );
  }
  if (error instanceof SdkHttpError) {
    return new McpCallFailure(
      "transport",
      sdkErrorCode(error.code),
      "MCP server request failed",
      false,
    );
  }
  if (error instanceof SdkError) {
    const protocolFailure =
      error.code === SdkErrorCode.InvalidResult ||
      error.code === SdkErrorCode.UnsupportedResultType;
    return new McpCallFailure(
      protocolFailure ? "protocol" : "transport",
      sdkErrorCode(error.code),
      protocolFailure
        ? "MCP server returned an invalid response"
        : "MCP server request failed",
      false,
    );
  }
  return new McpCallFailure(
    "transport",
    "request_failed",
    "MCP server request failed",
    false,
  );
}

async function runMcpOperation<T>(
  connector: McpConnector,
  timeoutSeconds: number,
  operation: (
    client: Client,
    deadlineAt: number,
    deadlineSignal: AbortSignal,
  ) => Promise<T>,
): Promise<McpOperationResult<T>> {
  let endpoint: URL;
  try {
    endpoint = new URL(connector.endpoint);
  } catch {
    throw new McpCommandError(
      "invalid_endpoint",
      "MCP connector definition has an invalid endpoint",
    );
  }

  const deadlineController = new AbortController();
  const deadlineAt = Date.now() + timeoutSeconds * 1_000;
  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: createMcpFetch(
      connector.target.kind === "builtin"
        ? connector.target.connectorSlug
        : connector.target.customConnectorId,
      deadlineController.signal,
    ),
    requestInit: { redirect: "error" },
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
    onInsufficientScope: "throw",
    maxStepUpRetries: 0,
  });
  const client = new Client(
    { name: "okou-cli", version: __CLI_VERSION__ },
    {
      versionNegotiation: {
        mode: "auto",
        probe: { maxRetries: 0 },
      },
      inputRequired: { autoFulfill: false },
    },
  );
  const timer = setTimeout(() => {
    deadlineController.abort(new McpDeadlineError("MCP command timed out"));
  }, timeoutSeconds * 1_000);

  let outcome:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: Error;
      };
  try {
    await client.connect(
      transport,
      requestOptions(deadlineAt, deadlineController.signal),
    );
    outcome = {
      ok: true,
      value: await operation(client, deadlineAt, deadlineController.signal),
    };
  } catch (error) {
    outcome = {
      ok: false,
      error: await safeMcpError(
        connector,
        error,
        deadlineController.signal,
        deadlineAt,
        timeoutSeconds,
      ),
    };
  }

  const cleanupWarning = await closeMcpClient(client, transport);
  clearTimeout(timer);

  if (!outcome.ok) {
    throw outcome.error;
  }
  return { value: outcome.value, cleanupWarning };
}

async function discoverMcpTools(
  client: Client,
  deadlineAt: number,
  deadlineSignal: AbortSignal,
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const toolNames = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let discoveryBytes = 0;

  for (let pageNumber = 1; pageNumber <= MAX_DISCOVERY_PAGES; pageNumber++) {
    const page = await client.request(
      {
        method: "tools/list",
        params: cursor === undefined ? {} : { cursor },
      },
      requestOptions(deadlineAt, deadlineSignal),
    );

    discoveryBytes += Buffer.byteLength(JSON.stringify(page), "utf8");
    if (discoveryBytes > MAX_DISCOVERY_BYTES) {
      throw new McpCommandError(
        "discovery_limit",
        "MCP tool discovery exceeds the 16 MiB aggregate limit",
      );
    }
    if (tools.length + page.tools.length > MAX_DISCOVERY_TOOLS) {
      throw new McpCommandError(
        "discovery_limit",
        "MCP tool discovery exceeds the 2,000 tool limit",
      );
    }

    for (const tool of page.tools) {
      if (toolNames.has(tool.name)) {
        throw new McpCommandError(
          "invalid_discovery",
          "MCP server returned duplicate tool names",
        );
      }
      toolNames.add(tool.name);
      tools.push(tool);
    }

    if (page.nextCursor === undefined) {
      return tools;
    }
    if (pageNumber === MAX_DISCOVERY_PAGES) {
      throw new McpCommandError(
        "discovery_limit",
        "MCP tool discovery exceeds the 100 page limit",
      );
    }
    if (cursors.has(page.nextCursor)) {
      throw new McpCommandError(
        "invalid_discovery",
        "MCP server repeated a tool page cursor",
      );
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return tools;
}

export async function listMcpTools(
  connector: McpConnector,
  timeoutSeconds: number,
): Promise<McpOperationResult<Tool[]>> {
  return runMcpOperation(
    connector,
    timeoutSeconds,
    async (client, deadlineAt, deadlineSignal) => {
      return discoverMcpTools(client, deadlineAt, deadlineSignal);
    },
  );
}

export async function callMcpTool(
  connector: McpConnector,
  toolName: string,
  input: JSONObject,
  timeoutSeconds: number,
): Promise<McpOperationResult<CallToolResult>> {
  return runMcpOperation(
    connector,
    timeoutSeconds,
    async (client, deadlineAt, deadlineSignal) => {
      const tools = await discoverMcpTools(client, deadlineAt, deadlineSignal);
      const tool = tools.find((candidate) => {
        return candidate.name === toolName;
      });
      if (!tool) {
        throw new McpCommandError(
          "tool_not_found",
          `MCP tool "${toolName}" was not found`,
        );
      }

      return client.callTool(
        { name: tool.name, arguments: input },
        {
          ...requestOptions(deadlineAt, deadlineSignal),
          toolDefinition: tool,
        },
      );
    },
  );
}
