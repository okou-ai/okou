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
const paths: Record<string, string> = {
  social_download_get: "downloadId",
  social_data_get: "jobId",
  social_data_cancel: "jobId",
  social_data_quote_continuation: "jobId",
  social_data_continue: "jobId",
  commerce_get: "id",
  data_get: "jobId",
  data_cancel: "jobId",
};
const reads = new Set([
  "social_status",
  "social_download_list",
  "social_download_get",
  "social_data_list",
  "social_data_get",
  "commerce_get",
  "data_capabilities",
  "data_list",
  "data_get",
]);
type Resolver = (info: {
  request: Request;
  params: Record<string, string>;
  toolName: string;
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

function projectArguments(
  name: string,
  path: string,
  toolName: string,
  request: Request,
  input: Record<string, unknown>,
): Parameters<Resolver>[0] | undefined {
  const parameter = paths[name];
  const params: Record<string, string> = {};
  let requestPath = path;
  if (parameter) {
    const value = z.string().parse(input[parameter]);
    params[parameter] = value;
    delete input[parameter];
    if (requestPath.includes(`:${parameter}`))
      requestPath = requestPath.replace(
        `:${parameter}`,
        encodeURIComponent(value),
      );
    else if (!requestPath.split("/").includes(encodeURIComponent(value)))
      return;
  }
  const url = new URL(requestPath);
  const isRead = reads.has(name);
  if (isRead)
    for (const [key, value] of Object.entries(input))
      if (key !== "requestIds" && value !== undefined)
        url.searchParams.set(key, String(value));
  const body = toolName === "social:*" ? { tool: name, input } : input;
  const projected = new Request(url, {
    method: isRead ? "GET" : "POST",
    headers: request.headers,
    signal: request.signal,
    ...(isRead ? {} : { body: JSON.stringify(body) }),
  });
  return { request: projected, params, toolName: name };
}

/** Mock the external MCP boundary while retaining existing command-body assertions. */
export function dataRouterTool(
  toolName: string,
  path: string,
  resolver: Resolver,
) {
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
    const input = { ...message.params?.arguments };
    const projected = projectArguments(name, path, toolName, request, input);
    if (!projected) return;
    const response = await resolver(projected);
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
