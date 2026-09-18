import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  indicatorsSchema,
  type Indicators,
} from "@okouai/api-contracts/contracts/chat-threads";
import { z } from "zod";
import { onRejection, settle, settleIncludingAbort } from "../utils";

interface McpIndicatorsAccess {
  readonly readScope: string;
  readonly scopes: readonly string[];
  readonly readIndicators: (signal: AbortSignal) => Promise<Indicators>;
}

/** SDK types and per-request transport state remain within this gateway. */
export async function serveMcpRequest(
  request: Request,
  access: McpIndicatorsAccess,
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
          "get_indicators",
          {
            description:
              "Read sparse activity and unread indicators for your authorized organization. " +
              "Returns agents and threads maps with active or unread entries. " +
              "Unread threads are limited to the latest 50 terminal markers within seven days. " +
              "Missing entries have no indicator; these are not per-run terminal statuses.",
            inputSchema: z.strictObject({}),
            outputSchema: indicatorsSchema,
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (_args, context) => {
            if (!access.scopes.includes(access.readScope)) {
              return {
                isError: true,
                content: [{ type: "text", text: "Insufficient scope" }],
              };
            }
            const signal = AbortSignal.any([
              requestSignal,
              context.mcpReq.signal,
            ]);
            signal.throwIfAborted();
            const result = await settle(access.readIndicators(signal), signal);
            if (result.ok) {
              return {
                structuredContent: result.value,
                content: [{ type: "text", text: JSON.stringify(result.value) }],
              };
            }
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: "Indicators are temporarily unavailable",
                },
              ],
            };
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
