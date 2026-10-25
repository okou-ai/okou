import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { DataRouterTool } from "@okouai/api-contracts/contracts/data-router-tools";
import { server } from "../../../mocks/server";
import { createDataCommand } from "../index";

const endpoint = "https://router.test/mcp";
const futureTool: DataRouterTool = {
  name: "future_research",
  title: "New research tool",
  description: "New Router capability",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["topic"],
  },
  _meta: { "ai.okou/data": { family: "data-search" } },
};
const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
let pages: { tools: DataRouterTool[]; nextCursor?: string }[];
let calls: unknown[];
let returnedBody: unknown;
let returnedStatus: number;
let output: string;

async function run(args: string[]) {
  await new Command("okou")
    .addCommand(createDataCommand())
    .parseAsync(["node", "okou", "data", ...args]);
}

describe("Data Router discovery and JSON calls", () => {
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_DATA_ROUTER_URL", endpoint);
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", "[]");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    pages = [{ tools: [futureTool] }];
    calls = [];
    returnedBody = { newField: [null, true, { count: 2 }] };
    returnedStatus = 200;
    output = "";
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      output += String(value);
    });
    server.use(
      http.all(endpoint, async ({ request }) => {
        if (request.method === "GET" || request.method === "HEAD")
          return new HttpResponse(null, { status: 405 });
        if (request.method === "DELETE")
          return new HttpResponse(null, { status: 204 });
        const message = rpcSchema.parse(await request.json());
        const reply = (result: unknown) => {
          return HttpResponse.json({ jsonrpc: "2.0", id: message.id, result });
        };
        if (message.method === "server/discover")
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        if (message.method === "initialize")
          return reply({
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "router", version: "1.0.0" },
          });
        if (message.method === "notifications/initialized")
          return new HttpResponse(null, { status: 204 });
        if (message.method === "tools/list")
          return reply(pages[message.params?.cursor === "second-page" ? 1 : 0]);
        if (message.method === "tools/call") {
          calls.push(message.params);
          const data = { status: returnedStatus, body: returnedBody };
          return reply({
            content: [{ type: "text", text: JSON.stringify({ data }) }],
            structuredContent: { data },
            isError: returnedStatus >= 400,
          });
        }
        return new HttpResponse(null, { status: 400 });
      }),
    );
  });
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("discovers all pages and applies individual and family preferences to new tools", async () => {
    pages = [
      {
        tools: [
          { ...futureTool, name: "hidden_tool" },
          {
            ...futureTool,
            name: "hidden_family",
            _meta: { "ai.okou/data": { family: "social" } },
          },
        ],
        nextCursor: "second-page",
      },
      { tools: [futureTool] },
    ];
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", '["data:hidden_tool","social"]');
    await run(["tools", "--json"]);
    expect(JSON.parse(output)).toEqual({
      tools: [
        {
          name: futureTool.name,
          title: futureTool.title,
          description: futureTool.description,
          family: "data-search",
        },
      ],
    });
  });

  it("describes the live input schema", async () => {
    await run(["describe", "future_research", "--json"]);
    expect(JSON.parse(output)).toEqual(futureTool);
  });

  it("passes new arguments and result fields unchanged for an explicitly called tool", async () => {
    vi.stubEnv(
      "OKOU_DISABLED_PAID_TOOLS",
      '["data:future_research","data-search"]',
    );
    await run([
      "call",
      "future_research",
      "--input",
      '{"topic":"launch","options":["new"],"newParameter":true}',
      "--json",
    ]);
    expect(calls).toEqual([
      {
        name: "future_research",
        arguments: { topic: "launch", options: ["new"], newParameter: true },
      },
    ]);
    expect(JSON.parse(output)).toEqual(returnedBody);
  });

  it("injects caller-owned history for a tool that declares that context", async () => {
    pages = [
      {
        tools: [
          {
            ...futureTool,
            name: "new_job_listing",
            _meta: {
              "ai.okou/data": { family: "data-search", requestHistory: true },
            },
          },
        ],
      },
    ];
    const ownedId = "00000000-0000-4000-8000-000000000001";
    server.use(
      http.get("http://localhost:3000/api/data/router/requests", () => {
        return HttpResponse.json({ requestIds: [ownedId] });
      }),
    );
    await run([
      "call",
      "new_job_listing",
      "--input",
      '{"requestIds":["caller-supplied"],"limit":2}',
      "--json",
    ]);
    expect(calls).toEqual([
      {
        name: "new_job_listing",
        arguments: { requestIds: [ownedId], limit: 2 },
      },
    ]);
    expect(JSON.parse(output)).toEqual(returnedBody);
  });

  it("prints a failed call once and sets a failure exit status", async () => {
    returnedStatus = 503;
    returnedBody = {
      error: {
        code: "SOURCE_UNAVAILABLE",
        detail: "Try another public source",
      },
    };
    await run(["call", "future_research", "--input", "{}", "--json"]);
    expect(JSON.parse(output)).toEqual(returnedBody);
    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([{ name: "future_research", arguments: {} }]);
  });
});
