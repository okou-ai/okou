import { HttpResponse, http } from "msw";
import { beforeEach } from "vitest";
import { z } from "zod";
import { server } from "./server";

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z
    .object({
      name: z.string().optional(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough()
    .optional(),
});
type Resolver = (info: {
  request: Request;
  toolName: string;
  toolArguments: Record<string, unknown>;
}) => Response | Promise<Response>;

// The main API remains the authority for the caller's saved request history.
// These CLI presentation scenarios do not assert ownership; the integration
// tests for that API cover attribution and filtering independently.
beforeEach(() => {
  server.use(
    http.get("http://localhost:3000/api/data/router/requests", () => {
      return HttpResponse.json({ requestIds: [] });
    }),
    http.get("https://data.okou.ai/mcp", () => {
      return new HttpResponse(null, { status: 405 });
    }),
  );
});

/** Mock the external MCP boundary without routing through the retired HTTP API. */
export function dataRouterTool(toolName: string, resolver: Resolver) {
  return http.all("https://data.okou.ai/mcp", async ({ request }) => {
    if (request.method === "GET")
      return new HttpResponse(null, { status: 405 });
    if (request.method === "DELETE")
      return new HttpResponse(null, { status: 204 });
    const message = rpcSchema.parse(await request.clone().json());
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
          serverInfo: { name: "data-router-test", version: "1.0.0" },
        },
      });
    if (message.method === "notifications/initialized")
      return new HttpResponse(null, { status: 202 });
    if (message.method !== "tools/call") return;
    const name = message.params?.name;
    if (
      !name ||
      (toolName === "social:*"
        ? !/^(?:linkedin|twitter|facebook|instagram|tiktok|youtube)_/.test(name)
        : name !== toolName)
    )
      return;
    const response = await resolver({
      request,
      toolName: name,
      toolArguments: message.params?.arguments ?? {},
    });
    if (response.type === "error") return HttpResponse.error();
    const raw = await response.text();
    const data = {
      status: response.status,
      body: raw ? JSON.parse(raw) : null,
    };
    return HttpResponse.json({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: JSON.stringify({ data }) }],
        structuredContent: { data },
        ...(response.status >= 400 ? { isError: true } : {}),
      },
    });
  });
}
