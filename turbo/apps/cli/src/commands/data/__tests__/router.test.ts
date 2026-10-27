import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  literal,
  number,
  object,
  string,
  union,
  unknown as zUnknown,
} from "zod";
import {
  DATA_ROUTER_PROTOCOL_VERSION,
  type DataRouterTool,
} from "@okouai/api-contracts/contracts/data-router-tools";
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
// Router serves only stateless 2026-07-28 requests, each carrying its own envelope.
const rpcSchema = object({
  id: union([string(), number()]),
  method: string(),
  params: object({
    _meta: object({
      "io.modelcontextprotocol/protocolVersion": literal(
        DATA_ROUTER_PROTOCOL_VERSION,
      ),
    }).catchall(zUnknown()),
    cursor: string().optional(),
    name: string().optional(),
    arguments: zUnknown().optional(),
  }),
});
let pages: { tools: DataRouterTool[]; nextCursor?: string }[];
let methods: string[];
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
    methods = [];
    calls = [];
    returnedBody = { newField: [null, true, { count: 2 }] };
    returnedStatus = 200;
    output = "";
    vi.spyOn(console, "log").mockImplementation((value: unknown) => {
      output += String(value);
    });
    server.use(
      http.all(endpoint, async ({ request }) => {
        if (request.method !== "POST")
          return new HttpResponse(null, { status: 405 });
        const message = rpcSchema.safeParse(await request.json());
        if (
          !message.success ||
          request.headers.get("MCP-Protocol-Version") !==
            DATA_ROUTER_PROTOCOL_VERSION ||
          request.headers.get("Mcp-Method") !== message.data.method
        )
          return new HttpResponse(null, { status: 400 });
        const { id, method, params } = message.data;
        methods.push(method);
        const reply = (result: object) => {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id,
            result: { ...result, resultType: "complete" },
          });
        };
        // Discovery results carry the cache hints Router's SDK attaches.
        const cache = { ttlMs: 0, cacheScope: "private" };
        if (method === "server/discover")
          return reply({
            supportedVersions: [DATA_ROUTER_PROTOCOL_VERSION],
            capabilities: { tools: {} },
            ...cache,
          });
        if (method === "tools/list")
          return reply({
            ...pages[params.cursor === "second-page" ? 1 : 0],
            ...cache,
          });
        if (method === "tools/call") {
          calls.push({ name: params.name, arguments: params.arguments });
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

  it("fails instead of falling back to the 2025 initialize handshake", async () => {
    server.use(
      http.post(endpoint, async ({ request }) => {
        const { id, method } = object({
          id: union([string(), number()]),
          method: string(),
        }).parse(await request.json());
        methods.push(method);
        return HttpResponse.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    await expect(run(["tools", "--json"])).rejects.toThrow("process.exit(1)");
    expect(methods).toEqual(["server/discover"]);
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
    expect(methods).toEqual(["server/discover", "tools/list", "tools/call"]);
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
