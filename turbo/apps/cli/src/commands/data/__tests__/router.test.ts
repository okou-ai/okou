import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function failedRun(args: string[]): Promise<string> {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("test process exit");
  });
  try {
    await expect(run(args)).rejects.toThrow("test process exit");
    expect(exit).toHaveBeenCalledWith(1);
    return error.mock.calls.flat().join("\n");
  } finally {
    error.mockRestore();
    exit.mockRestore();
  }
}

describe("Data Router discovery and JSON calls", () => {
  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "okou-data-test-"));
    // os.tmpdir() reads TMPDIR, which keeps saved responses inside this test.
    vi.stubEnv("TMPDIR", tempRoot);
    vi.stubEnv("OKOU_TOKEN", "test-okou-token");
    vi.stubEnv("OKOU_DATA_ROUTER_URL", endpoint);
    vi.stubEnv("OKOU_DISABLED_PAID_TOOLS", "[]");
    vi.stubEnv("OKOU_RUN_ID", "test-run");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", "");
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
      file: expect.stringMatching(/\/okou-data\/[a-f0-9]+\/0001\.json$/),
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
    expect(refreshed.file).toBe(join(dirname(first.file), "0002.json"));
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

  it("keeps mixed array outlines bounded without serializing containers", async () => {
    returnedBody = [{ text: "x".repeat(100_000) }, null, [1, 2]];
    await run(["call", "future_research", "--input", "{}"]);
    expect(callSummary().outline).toEqual([
      "(root): array(3)",
      "(root)[]: object | null | array, first object(1)",
    ]);
    expect(output.length).toBeLessThan(2_000);
  });

  it("gives parallel different-tool calls unique readable numeric references", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => {
        return run(["call", `parallel_${index}`, "--input", "{}"]);
      }),
    );
    output = "";
    await run(["history"]);
    const history = object({
      calls: array(object({ seq: number(), file: string(), tool: string() })),
    }).parse(printed());
    expect(history.calls).toHaveLength(8);
    expect(
      new Set(
        history.calls.map((call) => {
          return call.seq;
        }),
      ).size,
    ).toBe(8);
    for (const call of history.calls) {
      output = "";
      await run(["show", String(call.seq)]);
      expect(printed()).toEqual({
        file: call.file,
        path: "",
        value: returnedBody,
      });
    }
  });

  it.each([
    ["OKOU_TOKEN", "other-token"],
    ["OKOU_RUN_ID", "other-run"],
    ["OKOU_API_BACKEND_URL", "http://other-api.test"],
    ["OKOU_DATA_ROUTER_URL", `${endpoint}?route=other`],
  ])("isolates saved calls when %s changes", async (name, value) => {
    await run(["call", "future_research", "--input", "{}"]);
    const original = callSummary();
    vi.stubEnv(name, value);
    output = "";
    await run(["history"]);
    expect(printed()).toEqual({ dir: expect.any(String), calls: [] });
    output = "";
    returnedBody = { freshContext: true };
    await run(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(2);
    expect(callSummary().file).not.toBe(original.file);
    expect(JSON.parse(await readFile(callSummary().file, "utf8"))).toEqual(
      returnedBody,
    );
  });

  it("isolates saved calls when the selected account context changes", async () => {
    const context = join(tempRoot, "accounts.json");
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", context);
    await writeFile(context, JSON.stringify({ connectionId: "account-a" }));
    await run(["call", "future_research", "--input", "{}"]);
    const original = callSummary();
    await writeFile(context, JSON.stringify({ connectionId: "account-b" }));
    output = "";
    await run(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(2);
    expect(callSummary().file).not.toBe(original.file);
  });

  it("requires authentication before accepting a cache hit", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    vi.stubEnv("OKOU_TOKEN", "");
    const error = await failedRun(["call", "future_research", "--input", "{}"]);
    expect(error).toMatch(/authenticat|OKOU_TOKEN/i);
    expect(calls).toHaveLength(1);
  });

  it("does not repeat a paid request when saved bytes are missing", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const { file } = callSummary();
    await rm(file);
    const error = await failedRun(["call", "future_research", "--input", "{}"]);
    expect(error).toContain("--refresh");
    expect(calls).toHaveLength(1);
  });

  it("does not repeat a paid request when its history index is missing", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const { file } = callSummary();
    await rm(join(dirname(file), "index.jsonl"));
    const error = await failedRun(["call", "future_research", "--input", "{}"]);
    expect(error).toMatch(/do not repeat/i);
    expect(error).toContain("--refresh");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(returnedBody);
  });

  it("surfaces corrupt history rather than silently sending a paid request", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const directory = dirname(callSummary().file);
    await writeFile(join(directory, "index.jsonl"), "{interrupted");
    await failedRun(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(1);
  });

  it("reports completed-request metadata and surviving bytes if indexing fails", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const directory = dirname(callSummary().file);
    await rm(join(directory, "index.jsonl"));
    await mkdir(join(directory, "index.jsonl"));
    const error = await failedRun([
      "call",
      "future_research",
      "--input",
      "{}",
      "--refresh",
    ]);
    expect(calls).toHaveLength(2);
    expect(error).toContain("request-2");
    expect(error).toContain(join(directory, "0002.json"));
    expect(error).toMatch(/do not repeat/i);
    expect(
      JSON.parse(await readFile(join(directory, "0002.json"), "utf8")),
    ).toEqual(returnedBody);
  });

  it("rejects symlinked indexes without following or modifying the target", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const directory = dirname(callSummary().file);
    const target = join(tempRoot, "unrelated.txt");
    await writeFile(target, "private target");
    await rm(join(directory, "index.jsonl"));
    await symlink(target, join(directory, "index.jsonl"));
    await failedRun(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(1);
    expect(await readFile(target, "utf8")).toBe("private target");
  });

  it("rejects a symlinked store directory before sending a request", async () => {
    const target = join(tempRoot, "unrelated-directory");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, join(tempRoot, "okou-data"));
    await failedRun(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when the configured account context cannot be read", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    vi.stubEnv(
      "OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE",
      join(tempRoot, "missing.json"),
    );
    await failedRun(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(1);
  });

  it("rejects permissive existing indexes before sending a request", async () => {
    await run(["call", "future_research", "--input", "{}"]);
    const index = join(dirname(callSummary().file), "index.jsonl");
    await chmod(index, 0o644);
    await failedRun(["call", "future_research", "--input", "{}"]);
    expect(calls).toHaveLength(1);
  });

  it("lists saved calls in order", async () => {
    await run(["call", "future_research", "--input", '{"topic":"one"}']);
    output = "";
    await run(["call", "future_research", "--input", '{"topic":"two"}']);
    const directory = dirname(callSummary().file);
    output = "";
    await run(["history", "--json"]);
    expect(printed()).toEqual({
      dir: directory,
      calls: [
        {
          seq: 1,
          savedAt: expect.any(String),
          tool: "future_research",
          status: 200,
          bytes: expect.any(Number),
          file: join(directory, "0001.json"),
          input: { topic: "one" },
        },
        {
          seq: 2,
          savedAt: expect.any(String),
          tool: "future_research",
          status: 200,
          bytes: expect.any(Number),
          file: join(directory, "0002.json"),
          input: { topic: "two" },
        },
      ],
    });
  });
});
