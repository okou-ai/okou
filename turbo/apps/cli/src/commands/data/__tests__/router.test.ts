import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  union,
  unknown as zUnknown,
} from "zod";
import {
  DATA_ROUTER_PROTOCOL_VERSION,
  type DataRouterFamily,
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
let pages: {
  tools: DataRouterTool[];
  nextCursor?: string;
  _meta: { "ai.okou/data": { families: DataRouterFamily[] } };
}[];
let methods: string[];
let calls: unknown[];
let returnedBody: unknown;
let returnedStatus: number;
let output: string;
let tempRoot: string;
const summarySchema = object({
  status: number(),
  requestId: string().optional(),
  file: string(),
  bytes: number(),
  reused: boolean().optional(),
  savedAt: string().optional(),
  outline: array(string()),
  next: string(),
});

async function run(args: string[]) {
  const argv = ["node", "okou", "data", ...args];
  const cli = new Command("okou");
  await registerRequestedCommand(cli, argv);
  await cli.parseAsync(argv);
}

function callSummary() {
  return summarySchema.parse(JSON.parse(output));
}

function printed(): unknown {
  return JSON.parse(output);
}

describe("Data Router discovery and JSON calls", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "okou-data-test-"));
    // os.tmpdir() reads TMPDIR, which keeps saved responses inside this test.
    vi.stubEnv("TMPDIR", tempRoot);
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_DATA_ROUTER_URL", endpoint);
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", "[]");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    pages = [
      {
        tools: [futureTool],
        _meta: { "ai.okou/data": { families: [] } },
      },
    ];
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
          const envelope = { requestId: `request-${calls.length}`, data };
          return reply({
            content: [{ type: "text", text: JSON.stringify(envelope) }],
            structuredContent: envelope,
            isError: returnedStatus >= 400,
          });
        }
        return new HttpResponse(null, { status: 400 });
      }),
    );
  });
  afterEach(async () => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempRoot, { recursive: true, force: true });
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

  it("passes new arguments unchanged and saves the unchanged result body", async () => {
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
    expect(methods).toEqual(["server/discover", "tools/list", "tools/call"]);
    const summary = callSummary();
    const content = `${JSON.stringify(returnedBody, null, 2)}\n`;
    expect(summary).toEqual({
      status: 200,
      requestId: "request-1",
      file: join(tempRoot, "okou-data", "0001-future_research.json"),
      bytes: Buffer.byteLength(content),
      outline: [
        "newField: array(3)",
        "newField[]: null | boolean | object, first null",
      ],
      next: expect.stringContaining("okou data show 1 <path>"),
    });
    expect(await readFile(summary.file, "utf8")).toBe(content);
    expect((await stat(summary.file)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(summary.file))).mode & 0o777).toBe(0o700);
  });

  it("outlines nested list fields and inlines small scalar objects", async () => {
    returnedBody = {
      success: true,
      paging: { hasMore: true, cursor: "next-page" },
      data: {
        commentCount: 40,
        comments: Array.from({ length: 20 }, (_, index) => {
          return {
            username: `user-${index}`,
            text: "x".repeat(70),
            parentCommentId: index === 3 ? "parent" : null,
          };
        }),
      },
    };
    await run(["call", "future_research", "--input", '{"topic":"posts"}']);
    expect(callSummary().outline).toEqual([
      "success: true",
      'paging: {hasMore: true, cursor: "next-page"}',
      "data: object(2)",
      "data.commentCount: 40",
      "data.comments: array(20)",
      'data.comments[].username: "user-0"',
      `data.comments[].text: "${"x".repeat(60)}…" (70 chars)`,
      'data.comments[].parentCommentId: "parent"',
    ]);
  });

  it("reuses a saved response for the same input without sending a request", async () => {
    await run(["call", "future_research", "--input", '{"a":1,"b":[2]}']);
    const first = callSummary();
    output = "";
    returnedBody = { changed: true };
    await run(["call", "future_research", "--input", '{"b":[2],"a":1}']);
    expect(calls).toHaveLength(1);
    expect(callSummary()).toEqual({
      ...first,
      reused: true,
      savedAt: expect.any(String),
      next: expect.stringContaining("--refresh"),
    });

    output = "";
    await run([
      "call",
      "future_research",
      "--input",
      '{"a":1,"b":[2]}',
      "--refresh",
    ]);
    expect(calls).toHaveLength(2);
    const refreshed = callSummary();
    expect(refreshed.file).toBe(
      join(tempRoot, "okou-data", "0002-future_research.json"),
    );
    expect(refreshed.reused).toBeUndefined();
    expect(JSON.parse(await readFile(refreshed.file, "utf8"))).toEqual({
      changed: true,
    });
  });

  it("injects caller-owned history and never reuses that response", async () => {
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
        _meta: { "ai.okou/data": { families: [] } },
      },
    ];
    const ownedId = "00000000-0000-4000-8000-000000000001";
    server.use(
      http.get("http://localhost:3000/api/data/router/requests", () => {
        return HttpResponse.json({ requestIds: [ownedId] });
      }),
    );
    const args = [
      "call",
      "request_history",
      "--input",
      '{"requestIds":["caller-supplied"],"limit":2}',
      "--json",
    ];
    await run(args);
    output = "";
    await run(args);
    expect(calls).toEqual([
      {
        name: "request_history",
        arguments: { requestIds: [ownedId], limit: 2 },
      },
      {
        name: "request_history",
        arguments: { requestIds: [ownedId], limit: 2 },
      },
    ]);
    expect(callSummary().reused).toBeUndefined();
  });

  it("saves a failed call, sets a failure exit status and does not reuse it", async () => {
    returnedStatus = 503;
    returnedBody = {
      error: {
        code: "SOURCE_UNAVAILABLE",
        detail: "Try another public source",
      },
    };
    await run(["call", "future_research", "--input", "{}", "--json"]);
    const summary = callSummary();
    expect(summary.status).toBe(503);
    expect(summary.next).toContain("failed with status 503");
    expect(JSON.parse(await readFile(summary.file, "utf8"))).toEqual(
      returnedBody,
    );
    expect(process.exitCode).toBe(1);

    output = "";
    await run(["call", "future_research", "--input", "{}", "--json"]);
    expect(calls).toEqual([
      { name: "future_research", arguments: {} },
      { name: "future_research", arguments: {} },
    ]);
  });

  it("saves a large response whole and limits the outline", async () => {
    returnedBody = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => {
        return [
          `field${index}`,
          Array.from({ length: 500 }, () => {
            return index;
          }),
        ];
      }),
    );
    await run(["call", "future_research", "--input", "{}"]);
    const summary = callSummary();
    expect(JSON.parse(await readFile(summary.file, "utf8"))).toEqual(
      returnedBody,
    );
    expect(summary.outline).toHaveLength(61);
    expect(summary.outline.at(-1)).toBe(
      "… 100 more fields; narrow with okou data show <ref> <path> --outline",
    );
  });

  it("shows saved values by number and path, with array limits", async () => {
    returnedBody = {
      data: {
        comments: [{ username: "a" }, { username: "b" }, { username: "c" }],
      },
    };
    await run(["call", "future_research", "--input", "{}"]);
    const { file } = callSummary();

    output = "";
    await run(["show", "1", "data.comments", "--limit", "2"]);
    expect(printed()).toEqual({
      file,
      path: "data.comments",
      count: 3,
      shown: 2,
      value: [{ username: "a" }, { username: "b" }],
    });

    output = "";
    await run(["show", "1", "data.comments[].username"]);
    expect(printed()).toEqual({
      file,
      path: "data.comments[].username",
      count: 3,
      value: ["a", "b", "c"],
    });

    output = "";
    await run(["show", "1", "data.comments[2]", "--outline"]);
    expect(printed()).toEqual({
      file,
      path: "data.comments[2]",
      outline: ['username: "c"'],
    });
  });

  it("explains a missing path with the available keys", async () => {
    returnedBody = { data: { comments: [] } };
    await run(["call", "future_research", "--input", "{}"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(run(["show", "1", "data.items"])).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(error.mock.calls.flat().join("\n")).toContain(
      "data.items does not exist; available keys: comments",
    );
  });

  it("shows any JSON file path", async () => {
    const file = join(tempRoot, "local.json");
    await writeFile(file, JSON.stringify({ rows: [{ id: 1 }] }));
    await run(["show", file, "--outline"]);
    expect(printed()).toEqual({
      file,
      path: "",
      outline: ["rows: array(1)", "rows[].id: 1"],
    });
  });

  it("lists saved calls in order", async () => {
    await run(["call", "future_research", "--input", '{"topic":"one"}']);
    await run(["call", "future_research", "--input", '{"topic":"two"}']);
    output = "";
    await run(["history", "--json"]);
    expect(printed()).toEqual({
      dir: join(tempRoot, "okou-data"),
      calls: [
        {
          seq: 1,
          savedAt: expect.any(String),
          tool: "future_research",
          status: 200,
          bytes: expect.any(Number),
          file: join(tempRoot, "okou-data", "0001-future_research.json"),
          input: { topic: "one" },
        },
        {
          seq: 2,
          savedAt: expect.any(String),
          tool: "future_research",
          status: 200,
          bytes: expect.any(Number),
          file: join(tempRoot, "okou-data", "0002-future_research.json"),
          input: { topic: "two" },
        },
      ],
    });
  });
});
