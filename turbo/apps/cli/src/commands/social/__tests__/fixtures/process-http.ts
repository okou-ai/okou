import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { z } from "zod";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

// Supply the build-time constants when exercising the unchanged source entry point.
Object.assign(globalThis, {
  __CLI_VERSION__: "0.0.0-test",
  __DEFAULT_SENTRY_DSN__: "",
});

const [log, failPage] = process.argv.splice(2, 2);
if (!log) throw new Error("Missing fixture request log");
const server = setupServer(
  http.all("https://data.okou.ai/mcp", async ({ request }) => {
    if (request.method === "GET")
      return new HttpResponse(null, { status: 405 });
    const message = z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        method: z.string(),
        params: z
          .object({
            name: z.string().optional(),
            arguments: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .parse(await request.json());
    if (message.method === "server/discover")
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    if (message.method === "initialize")
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      });
    if (message.method === "notifications/initialized")
      return new HttpResponse(null, { status: 202 });
    if (
      message.method !== "tools/call" ||
      message.params?.name !== "instagram_comments"
    )
      throw new Error("Unexpected fixture MCP request");
    const body = { tool: message.params.name, input: message.params.arguments };
    function reply(body: unknown, status = 200) {
      const data = { status, body };
      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ data }) }],
          structuredContent: { data },
          ...(status >= 400 ? { isError: true } : {}),
        },
      });
    }

    appendFileSync(log, `${JSON.stringify(body)}\n`);
    const input =
      typeof body === "object" && body !== null && "input" in body
        ? body.input
        : null;
    const cursor =
      typeof input === "object" && input !== null && "cursor" in input
        ? input.cursor
        : undefined;
    if (cursor && failPage === "1") {
      return reply(
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: "Temporary page failure",
            retryable: true,
          },
        },
        502,
      );
    }
    const ids = cursor ? ["four"] : ["one", "two", "three"];
    return reply({
      tool: "instagram_comments",
      billingCategory: "request",
      billingQuantity: 1,
      creditsCharged: 3,
      collection: cursor
        ? { state: "complete", itemsReturned: 1 }
        : { state: "more", itemsReturned: 3, nextInput: { cursor: "next" } },
      result: {
        comments: ids.map((id) => {
          return { id };
        }),
        hasMore: !cursor,
      },
    });
  }),
);
server.listen({ onUnhandledRequest: "error" });
syncBuiltinESMExports();
process.once("exit", () => {
  return server.close();
});
