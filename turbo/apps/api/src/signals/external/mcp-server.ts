import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
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
  readonly listThreads: (
    input: McpListChatThreadsInput,
    signal: AbortSignal,
  ) => Promise<McpThreadReadResult<McpListChatThreadsOutput>>;
  readonly getThread: (
    input: McpGetChatThreadInput,
    signal: AbortSignal,
  ) => Promise<McpThreadReadResult<McpGetChatThreadOutput>>;
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
  operation: () => Promise<McpThreadReadResult<T>>,
  signal: AbortSignal,
) {
  if (!access.scopes.includes(access.readScope)) {
    return toolError("Insufficient scope");
  }
  signal.throwIfAborted();
  const result = await settle(operation(), signal);
  if (!result.ok) {
    return toolError(
      "Thread information is temporarily unavailable. Retry, or narrow the Agent/time filters for a large search.",
    );
  }
  if (result.value.kind !== "ok") {
    return toolError(result.value.message);
  }
  return {
    structuredContent: result.value.data,
    content: [
      { type: "text" as const, text: JSON.stringify(result.value.data) },
    ],
  };
}

/** SDK types and per-request transport state remain within this gateway. */
export async function serveMcpRequest(
  request: Request,
  access: McpChatAccess,
  requestSignal: AbortSignal,
): Promise<Response> {
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "okou", version: "1.0.0" },
        { capabilities: { tools: { listChanged: false } } },
      );
      if (access.scopes.includes(access.readScope)) {
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
            const signal = AbortSignal.any([
              requestSignal,
              context.mcpReq.signal,
            ]);
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
            const signal = AbortSignal.any([
              requestSignal,
              context.mcpReq.signal,
            ]);
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
      return server;
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
