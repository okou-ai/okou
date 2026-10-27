import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  number,
  object,
  record,
  string,
  union,
  unknown as zUnknown,
} from "zod";
import type { DataRouterTool } from "@okouai/api-contracts/contracts/data-router-tools";
import { server } from "../../../mocks/server";
import { registerRequestedCommand } from "../../../okou";

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
const rpcSchema = object({
  id: union([string(), number()]).optional(),
  method: string(),
  params: record(string(), zUnknown()).optional(),
});
let pages: {
  tools: DataRouterTool[];
  nextCursor?: string;
  _meta?: Record<string, unknown>;
}[];
let calls: unknown[];
let returnedBody: unknown;
let returnedStatus: number;
let output: string;

async function run(args: string[]) {
  const argv = ["node", "okou", "data", ...args];
  const cli = new Command("okou");
  await registerRequestedCommand(cli, argv);
  await cli.parseAsync(argv);
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

  it("discovers all pages and applies preferences to families Okou does not know", async () => {
    const family = (id: string, title: string) => {
      return {
        id,
        title: { "en-US": title, "zh-Hans": `${title} (zh)` },
        description: { "en-US": `${title} description` },
        summary: `Use ${id} tools.`,
      };
    };
    const familiesMeta = {
      "ai.okou/data": {
        families: [
          family("future-family", "Future research"),
          family("hidden-family", "Hidden research"),
          family("empty-family", "Empty research"),
        ],
      },
    };
    pages = [
      {
        tools: [
          {
            ...futureTool,
            name: "hidden_tool",
            _meta: { "ai.okou/data": { family: "hidden-family" } },
          },
          { ...futureTool, name: "billing_get", _meta: undefined },
        ],
        nextCursor: "second-page",
        _meta: familiesMeta,
      },
      {
        tools: [
          {
            ...futureTool,
            _meta: { "ai.okou/data": { family: "future-family" } },
          },
        ],
        _meta: familiesMeta,
      },
    ];
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", '["hidden-family"]');
    await run(["tools", "--json"]);
    expect(JSON.parse(output)).toEqual({
      families: [
        {
          id: "future-family",
          title: "Future research",
          summary: "Use future-family tools.",
        },
      ],
      tools: [
        {
          name: futureTool.name,
          title: futureTool.title,
          description: futureTool.description,
          family: "future-family",
        },
      ],
    });
  });

  it("describes the live input schema", async () => {
    await run(["describe", "future_research", "--json"]);
    expect(JSON.parse(output)).toEqual(futureTool);
  });

  it("passes new arguments and result fields unchanged for an explicitly called tool", async () => {
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", '["data-search"]');
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
            name: "request_history",
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
      "request_history",
      "--input",
      '{"requestIds":["caller-supplied"],"limit":2}',
      "--json",
    ]);
    expect(calls).toEqual([
      {
        name: "request_history",
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
