import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  isJSONRPCNotification,
  isJSONRPCRequest,
  type CallToolResult,
  type RequestId,
  type RequestParams,
  type Tool,
} from "@modelcontextprotocol/client";
import chalk from "chalk";
import { delay, http, HttpResponse } from "msw";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { server } from "../../../mocks/server";
import {
  customConnector,
  runMcpConnector,
  stubCustomConnectors,
  stubRunMcpConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { mcpCommand } from "../index";

const CONNECTOR_ID = "44444444-4444-4444-8444-444444444444";
const MCP_ENDPOINT = "https://mcp.example.test/server";
const SESSION_ID = "mcp-session-test";

type ProtocolEra = "modern" | "legacy";

interface SeenMcpRequest {
  readonly httpMethod: string;
  readonly method?: string;
  readonly params?: RequestParams;
  readonly intent: string | null;
}

interface McpServerOptions {
  readonly era: ProtocolEra;
  readonly pages?: readonly (readonly Tool[])[];
  readonly callResult?: CallToolResult;
  readonly callResponse?: () => Response;
  readonly listResponse?: (requestId: RequestId) => Response;
  readonly deleteResponse?: () => Response | Promise<Response>;
}

function processExit(): never {
  throw new Error("process.exit called");
}

function pageCursor(params: RequestParams | undefined): string | undefined {
  if (params === undefined || !("cursor" in params)) {
    return undefined;
  }
  const cursor: unknown = params.cursor;
  return typeof cursor === "string" ? cursor : undefined;
}

function stubMcpServer(options: McpServerOptions): SeenMcpRequest[] {
  const seen: SeenMcpRequest[] = [];
  const pages = options.pages ?? [[]];
  const callResult = options.callResult ?? {
    content: [{ type: "text", text: "tool completed" }],
  };

  server.use(
    http.all(MCP_ENDPOINT, async ({ request }) => {
      const intent = request.headers.get("x-okou-connector-intent");
      if (request.method === "DELETE") {
        seen.push({ httpMethod: request.method, intent });
        if (options.deleteResponse) {
          return options.deleteResponse();
        }
        return new HttpResponse(null, { status: 204 });
      }

      const message: unknown = await request.json();
      if (isJSONRPCNotification(message)) {
        seen.push({
          httpMethod: request.method,
          method: message.method,
          params: message.params,
          intent,
        });
        return new HttpResponse(null, { status: 204 });
      }
      if (!isJSONRPCRequest(message)) {
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid request" },
          },
          { status: 400 },
        );
      }

      seen.push({
        httpMethod: request.method,
        method: message.method,
        params: message.params,
        intent,
      });

      if (message.method === "server/discover") {
        if (options.era === "legacy") {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
            },
          },
          { headers: { "mcp-session-id": SESSION_ID } },
        );
      }

      if (message.method === "initialize") {
        return HttpResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "test-mcp", version: "1.0.0" },
            },
          },
          { headers: { "mcp-session-id": SESSION_ID } },
        );
      }

      if (message.method === "tools/list") {
        if (options.listResponse) {
          return options.listResponse(message.id);
        }
        const cursor = pageCursor(message.params);
        const pageIndex = cursor === undefined ? 0 : Number(cursor);
        const tools = pages[pageIndex];
        if (tools === undefined) {
          return HttpResponse.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "Unknown cursor" },
          });
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...(options.era === "modern" ? { resultType: "complete" } : {}),
            ttlMs: 0,
            cacheScope: "private",
            tools,
            ...(pageIndex + 1 < pages.length
              ? { nextCursor: String(pageIndex + 1) }
              : {}),
          },
        });
      }

      if (message.method === "tools/call") {
        if (options.callResponse) {
          return options.callResponse();
        }
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            ...(options.era === "modern" ? { resultType: "complete" } : {}),
            ...callResult,
          },
        });
      }

      return HttpResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
    }),
  );
  return seen;
}

function stubConnectorList(
  overrides: Parameters<typeof runMcpConnector>[0] = {},
): void {
  server.use(stubRunMcpConnectors([runMcpConnector(overrides)]));
}

function outputText(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.flat().join("\n");
}

function insufficientScopeResponse(scope: string): Response {
  return new HttpResponse(null, {
    status: 403,
    headers: {
      "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}", resource_metadata="https://untrusted.example.test/oauth-resource", error_description="upstream-secret-description"`,
    },
  });
}

describe("okou mcp command", () => {
  const exit = vi.spyOn(process, "exit").mockImplementation(processExit);
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let inputDirectory: string;

  beforeAll(async () => {
    inputDirectory = await mkdtemp(join(process.cwd(), ".mcp-test-"));
  });

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
  });

  afterEach(() => {
    exit.mockClear();
    consoleLog.mockClear();
    consoleError.mockClear();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await rm(inputDirectory, { recursive: true, force: true });
  });

  it("lists server-authorized MCP definitions with safe JSON fields", async () => {
    const secondId = "55555555-5555-4555-8555-555555555555";
    server.use(
      stubRunMcpConnectors([
        runMcpConnector({
          target: { kind: "custom", customConnectorId: secondId },
          slug: "_alpha",
          displayName: "Alpha MCP",
          endpoint: "https://alpha-mcp.example.test/server",
          connected: false,
        }),
        runMcpConnector({ slug: "_zulu" }),
      ]),
    );

    await mcpCommand.parseAsync(["node", "okou", "list", "--json"]);

    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        connectors: [
          {
            slug: "_alpha",
            target: { kind: "custom", customConnectorId: secondId },
            connectionId: "77777777-7777-4777-8777-777777777777",
            displayName: "Alpha MCP",
            transport: "streamable-http",
            endpoint: "https://alpha-mcp.example.test/server",
            connected: false,
          },
          {
            slug: "_zulu",
            target: { kind: "custom", customConnectorId: CONNECTOR_ID },
            connectionId: "77777777-7777-4777-8777-777777777777",
            displayName: "Acme MCP",
            transport: "streamable-http",
            endpoint: MCP_ENDPOINT,
            connected: true,
          },
        ],
      }),
    );
    const output = outputText(consoleLog);
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("secrets.secret");
  });

  it("rejects a shared admitted MCP name before opening either server", async () => {
    const otherId = "55555555-5555-4555-8555-555555555555";
    server.use(
      stubRunMcpConnectors([
        runMcpConnector(),
        runMcpConnector({
          target: { kind: "custom", customConnectorId: otherId },
          slug: "_other",
        }),
      ]),
    );
    const seen = stubMcpServer({ era: "modern" });
    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "Acme MCP"]),
    ).rejects.toThrow("process.exit called");
    expect(seen).toStrictEqual([]);
    const output = outputText(consoleError);
    expect(output).toContain(`custom:${CONNECTOR_ID}`);
    expect(output).toContain(`custom:${otherId}`);
  });

  it.each([
    "_acme-mcp",
    CONNECTOR_ID,
    `custom:${CONNECTOR_ID}`,
    "custom:_acme-mcp",
    "Acme MCP",
  ])(
    "discovers tools selected by %s with exact intent and cleanup",
    async (selector) => {
      const searchTool = {
        name: "search",
        description: "Search documents",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      } satisfies Tool;
      const fetchTool = {
        name: "fetch",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
        },
      } satisfies Tool;
      const tools = [searchTool, fetchTool];
      stubConnectorList();
      const seen = stubMcpServer({
        era: "modern",
        pages: [[searchTool], [fetchTool]],
      });

      await mcpCommand.parseAsync([
        "node",
        "okou",
        "list-tools",
        selector,
        "--json",
      ]);

      expect(consoleLog).toHaveBeenCalledWith(
        JSON.stringify({ connectorSlug: "_acme-mcp", tools }),
      );
      expect(
        seen.map((request) => {
          return request.method ?? request.httpMethod;
        }),
      ).toEqual(["server/discover", "tools/list", "tools/list"]);
      expect(seen[2]?.params).toMatchObject({ cursor: "1" });
      expect(
        seen.every((request) => {
          return request.intent === CONNECTOR_ID;
        }),
      ).toBe(true);
    },
  );

  it.each(["_acme-mcp", CONNECTOR_ID, "Acme MCP"])(
    "calls the exact tool selected by %s once after the 2025 handshake",
    async (selector) => {
      const tool = {
        name: "search",
        description: "Search documents",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      } satisfies Tool;
      const callResult = {
        content: [{ type: "text", text: "one result" }],
      } satisfies CallToolResult;
      stubConnectorList();
      const seen = stubMcpServer({
        era: "legacy",
        pages: [[tool]],
        callResult,
      });

      await mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        selector,
        "search",
        "--input",
        '{"query":"okou"}',
        "--json",
      ]);

      expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(callResult));
      expect(
        seen.map((request) => {
          return request.method ?? request.httpMethod;
        }),
      ).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
        "DELETE",
      ]);
      const calls = seen.filter((request) => {
        return request.method === "tools/call";
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params).toMatchObject({
        name: "search",
        arguments: { query: "okou" },
      });
      expect(
        seen.every((request) => {
          return request.intent === CONNECTOR_ID;
        }),
      ).toBe(true);
    },
  );

  it("reads call input from a file without exposing its contents", async () => {
    const inputPath = join(inputDirectory, "input.json");
    await writeFile(inputPath, '{"query":"from-file"}', "utf8");
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await mcpCommand.parseAsync([
      "node",
      "okou",
      "call",
      "_acme-mcp",
      "search",
      "--input-file",
      inputPath,
      "--json",
    ]);

    const call = seen.find((request) => {
      return request.method === "tools/call";
    });
    expect(call?.params).toMatchObject({
      arguments: { query: "from-file" },
    });
  });

  it("reads call input from piped stdin", async () => {
    const stdinIterator = vi
      .spyOn(process.stdin, Symbol.asyncIterator)
      .mockImplementation(async function* (): AsyncGenerator<
        Buffer,
        undefined,
        unknown
      > {
        yield Buffer.from('{"query":"from-stdin"}');
        return undefined;
      });
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    try {
      await mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--json",
      ]);
    } finally {
      stdinIterator.mockRestore();
    }

    const call = seen.find((request) => {
      return request.method === "tools/call";
    });
    expect(call?.params).toMatchObject({
      arguments: { query: "from-stdin" },
    });
  });

  it("rejects conflicting input sources before resolving the connector", async () => {
    const inputPath = join(inputDirectory, "conflicting-input.json");
    await writeFile(inputPath, "{}", "utf8");
    let apiCalls = 0;
    server.use(
      http.get("http://localhost:3000/api/custom-connectors", () => {
        apiCalls++;
        return HttpResponse.json({ connectors: [] });
      }),
    );

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{}",
        "--input-file",
        inputPath,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(apiCalls).toBe(0);
  });

  it("rejects invalid JSON before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      "MCP tool input must be valid JSON",
    );
  });

  it("rejects non-object JSON before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "[]",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      "MCP tool input must be a JSON object",
    );
  });

  it("does not retry a failed tool call or expose its upstream body", async () => {
    const upstreamSecret = "upstream-secret-value";
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "side-effect",
            inputSchema: { type: "object" },
          },
        ],
      ],
      callResponse: () => {
        return HttpResponse.text(upstreamSecret, { status: 500 });
      },
    });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "side-effect",
        "--input",
        "{}",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(1);
    const errors = outputText(consoleError);
    expect(errors).toContain("MCP server request failed");
    expect(errors).not.toContain(upstreamSecret);
    expect(errors).not.toContain("Error POSTing");
  });

  it("requests exact-run reauthorization for a valid insufficient-scope challenge without retrying", async () => {
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      listResponse: () => {
        return insufficientScopeResponse("read write read");
      },
    });
    let requestedScopes: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/mcp-connectors/oauth2/reauthorize",
        async ({ request }) => {
          requestedScopes = await request.json();
          return HttpResponse.json({
            kind: "oauth",
            authorizationUrl: "https://authorize.example.test/consent",
            expiresAt: "2026-09-03T12:15:00.000Z",
          });
        },
      ),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(requestedScopes).toStrictEqual({
      target: { kind: "custom", customConnectorId: CONNECTOR_ID },
      scopes: ["read", "write"],
    });
    expect(
      seen.filter((request) => {
        return request.method === "tools/list";
      }),
    ).toHaveLength(1);
    const errors = outputText(consoleError);
    expect(errors).toContain(
      "[Authorize MCP connector](https://authorize.example.test/consent)",
    );
    expect(errors).toContain("The failed MCP request was not retried");
    expect(errors).toContain("Start a new run after authorization");
    expect(errors).not.toContain("upstream-secret-description");
    expect(errors).not.toContain("untrusted.example.test");
  });

  it.each(["catalog-service", "builtin:catalog-service", "Catalog Service"])(
    "calls a builtin MCP tool selected by %s with the builtin owner intent",
    async (selector) => {
      stubConnectorList({
        target: { kind: "builtin", connectorSlug: "catalog-service" },
        slug: "catalog-service",
        displayName: "Catalog Service",
      });
      const seen = stubMcpServer({
        era: "modern",
        pages: [[{ name: "search", inputSchema: { type: "object" } }]],
      });

      await mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        selector,
        "search",
        "--input",
        "{}",
        "--json",
      ]);

      expect(
        seen.every((request) => {
          return request.intent === "catalog-service";
        }),
      ).toBe(true);
      expect(
        seen.filter((request) => {
          return request.method === "tools/call";
        }),
      ).toHaveLength(1);
      expect(outputText(consoleLog)).toContain("tool completed");
    },
  );

  it("requires an explicit owner for a builtin/custom shared display name", async () => {
    server.use(
      stubRunMcpConnectors([
        runMcpConnector(),
        runMcpConnector({
          target: { kind: "builtin", connectorSlug: "acme-mcp" },
          slug: "acme-mcp",
        }),
      ]),
    );
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "Acme MCP"]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain("builtin:acme-mcp");
    expect(outputText(consoleError)).toContain(`custom:${CONNECTOR_ID}`);
  });

  it("returns the exact builtin account reconnect link without replaying a failed tool", async () => {
    const target = {
      kind: "builtin" as const,
      connectorSlug: "catalog-service",
    };
    const connectionId = "88888888-8888-4888-8888-888888888888";
    stubConnectorList({ target, connectionId, slug: "catalog-service" });
    const seen = stubMcpServer({
      era: "modern",
      pages: [[{ name: "write", inputSchema: { type: "object" } }]],
      callResponse: () => {
        return insufficientScopeResponse("write");
      },
    });
    const authorizationUrl = `https://app.okou.ai/connect/catalog-service?connectionId=${connectionId}`;
    let requestedBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/mcp-connectors/oauth2/reauthorize",
        async ({ request }) => {
          requestedBody = await request.json();
          return HttpResponse.json({
            kind: "reconnect",
            connectionId,
            authorizationUrl,
          });
        },
      ),
    );

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "catalog-service",
        "write",
        "--input",
        "{}",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestedBody).toStrictEqual({ target, scopes: ["write"] });
    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(1);
    expect(outputText(consoleError)).toContain(authorizationUrl);
    expect(outputText(consoleError)).toContain(
      "Start a new run after authorization",
    );
    expect(outputText(consoleError)).not.toContain("expires at");
  });

  it("reports unavailable reauthorization without retrying the insufficient-scope request", async () => {
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      listResponse: () => {
        return insufficientScopeResponse("admin");
      },
    });
    server.use(
      http.post(
        "http://localhost:3000/api/mcp-connectors/oauth2/reauthorize",
        () => {
          return HttpResponse.json(
            {
              error: {
                message: "MCP account is unavailable",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        },
      ),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain(
      "MCP scope reauthorization failed: MCP account is unavailable",
    );
    expect(
      seen.filter((request) => {
        return request.method === "tools/list";
      }),
    ).toHaveLength(1);
  });

  it("keeps scope reauthorization inside the command deadline", async () => {
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      listResponse: () => {
        return insufficientScopeResponse("admin");
      },
    });
    server.use(
      http.post(
        "http://localhost:3000/api/mcp-connectors/oauth2/reauthorize",
        async () => {
          await delay(2_000);
          return HttpResponse.json({
            kind: "oauth",
            authorizationUrl: "https://authorize.example.test/consent",
            expiresAt: "2026-09-03T12:15:00.000Z",
          });
        },
      ),
    );

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{}",
        "--timeout",
        "1s",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("timed out after 1s");
    expect(
      seen.filter((request) => {
        return request.method === "tools/list";
      }),
    ).toHaveLength(1);
  });

  it("keeps an oversized insufficient-scope challenge generic", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: () => {
        return insufficientScopeResponse("x".repeat(257));
      },
    });
    let apiCalls = 0;
    server.use(
      http.post(
        "http://localhost:3000/api/mcp-connectors/oauth2/reauthorize",
        () => {
          apiCalls += 1;
          return HttpResponse.json({
            kind: "oauth",
            authorizationUrl: "https://authorize.example.test/consent",
            expiresAt: "2026-09-03T12:15:00.000Z",
          });
        },
      ),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(apiCalls).toBe(0);
    expect(outputText(consoleError)).toContain("MCP server request failed");
  });

  it("rejects an unknown tool without sending tools/call", async () => {
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "missing",
        "--input",
        "{}",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      'MCP tool "missing" was not found',
    );
  });

  it("refuses MCP endpoint redirects", async () => {
    stubConnectorList();
    server.use(
      http.post(MCP_ENDPOINT, () => {
        return HttpResponse.redirect(
          "https://redirected.example.test/server",
          307,
        );
      }),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("MCP server request failed");
  });

  it("treats an empty discovery response as an ordinary empty result", async () => {
    server.use(stubRunMcpConnectors([]));

    await mcpCommand.parseAsync(["node", "okou", "list", "--json"]);

    expect(consoleLog).toHaveBeenCalledWith('{"connectors":[]}');
  });

  it("reports a discovery server error", async () => {
    server.use(
      http.get("http://localhost:3000/api/mcp-connectors", () => {
        return HttpResponse.json(
          {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "Discovery failed",
            },
          },
          { status: 500 },
        );
      }),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("Discovery failed");
  });

  it("rejects malformed discovery responses", async () => {
    server.use(
      http.get("http://localhost:3000/api/mcp-connectors", () => {
        return HttpResponse.json({ connectors: [{ id: CONNECTOR_ID }] });
      }),
    );

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list"]),
    ).rejects.toThrow("process.exit called");
  });

  it("rejects an unknown slug before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_not-admitted"]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      'MCP connector "_not-admitted" is not authorized for this Agent',
    );
  });

  it.each([
    "_acme-search",
    "33333333-3333-4333-8333-333333333333",
    "custom:33333333-3333-4333-8333-333333333333",
    "Acme Search",
  ])("rejects HTTP custom selector %s from MCP commands", async (selector) => {
    const connector = customConnector();
    stubConnectorList();
    server.use(stubCustomConnectors([connector]));
    const seen = stubMcpServer({ era: "modern" });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", selector]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain(
      `MCP connector "${selector}" is not authorized for this Agent`,
    );
  });

  it("rejects tool input above 1 MiB before opening an MCP connection", async () => {
    stubConnectorList();
    const seen = stubMcpServer({ era: "modern" });
    const oversizedInput = JSON.stringify({
      value: "x".repeat(1024 * 1024),
    });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        oversizedInput,
      ]),
    ).rejects.toThrow("process.exit called");

    expect(seen).toHaveLength(0);
    expect(outputText(consoleError)).toContain("exceeds the 1 MiB limit");
    expect(outputText(consoleError)).not.toContain("xxxx");
  });

  it("returns tool-level MCP errors without retrying", async () => {
    const toolError = {
      content: [{ type: "text", text: "invalid query" }],
      isError: true,
    } satisfies CallToolResult;
    stubConnectorList();
    const seen = stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
      callResult: toolError,
    });

    await mcpCommand.parseAsync([
      "node",
      "okou",
      "call",
      "_acme-mcp",
      "search",
      "--input",
      "{}",
      "--json",
    ]);

    expect(consoleLog).toHaveBeenCalledWith(JSON.stringify(toolError));
    expect(
      seen.filter((request) => {
        return request.method === "tools/call";
      }),
    ).toHaveLength(1);
  });

  it("warns instead of failing after a successful call whose legacy cleanup fails", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "legacy",
      pages: [
        [
          {
            name: "side-effect",
            inputSchema: { type: "object" },
          },
        ],
      ],
      deleteResponse: () => {
        return HttpResponse.text("cleanup failed", { status: 500 });
      },
    });

    await mcpCommand.parseAsync([
      "node",
      "okou",
      "call",
      "_acme-mcp",
      "side-effect",
      "--input",
      "{}",
      "--json",
    ]);

    expect(exit).not.toHaveBeenCalled();
    expect(outputText(consoleLog)).toContain("tool completed");
    const errors = outputText(consoleError);
    expect(errors).toContain("MCP session cleanup did not complete");
    expect(errors).not.toContain("cleanup failed");
  });

  it("preserves the primary failure when cleanup reaches the deadline", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "legacy",
      pages: [
        [
          {
            name: "search",
            inputSchema: { type: "object" },
          },
        ],
      ],
      deleteResponse: async () => {
        await delay(2_000);
        return new HttpResponse(null, { status: 204 });
      },
    });

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "missing",
        "--input",
        "{}",
        "--timeout",
        "1s",
      ]),
    ).rejects.toThrow("process.exit called");

    const errors = outputText(consoleError);
    expect(errors).toContain('MCP tool "missing" was not found');
    expect(errors).not.toContain("timed out");
  });

  it("rejects repeated pagination cursors", async () => {
    let listRequests = 0;
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: (requestId) => {
        listRequests++;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [],
            nextCursor: "same-cursor",
          },
        });
      },
    });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(listRequests).toBe(2);
    expect(outputText(consoleError)).toContain("repeated a tool page cursor");
  });

  it("rejects discovery above 2,000 tools", async () => {
    const tools = Array.from({ length: 2_001 }, (_, index): Tool => {
      return {
        name: `tool-${index}`,
        inputSchema: { type: "object" },
      };
    });
    stubConnectorList();
    stubMcpServer({ era: "modern", pages: [tools] });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("2,000 tool limit");
  });

  it("rejects discovery above 100 pages", async () => {
    let listRequests = 0;
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: (requestId) => {
        listRequests++;
        return HttpResponse.json({
          jsonrpc: "2.0",
          id: requestId,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [],
            nextCursor: `cursor-${listRequests}`,
          },
        });
      },
    });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(listRequests).toBe(100);
    expect(outputText(consoleError)).toContain("100 page limit");
  });

  it("rejects aggregate discovery above 16 MiB", async () => {
    const largeDescription = "d".repeat(8 * 1024 * 1024);
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      pages: [
        [
          {
            name: "first",
            description: largeDescription,
            inputSchema: { type: "object" },
          },
        ],
        [
          {
            name: "second",
            description: largeDescription,
            inputSchema: { type: "object" },
          },
        ],
      ],
    });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("16 MiB aggregate limit");
    expect(outputText(consoleError)).not.toContain("dddd");
  });

  it("rejects an oversized streamed response without buffering it", async () => {
    stubConnectorList();
    stubMcpServer({
      era: "modern",
      listResponse: () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
            controller.close();
          },
        });
        return new HttpResponse(body, {
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      mcpCommand.parseAsync(["node", "okou", "list-tools", "_acme-mcp"]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain(
      "MCP response exceeds the 16 MiB limit",
    );
  });

  it("uses one overall deadline", async () => {
    stubConnectorList();
    server.use(
      http.post(MCP_ENDPOINT, async () => {
        await delay(2_000);
        return HttpResponse.json({});
      }),
    );

    await expect(
      mcpCommand.parseAsync([
        "node",
        "okou",
        "call",
        "_acme-mcp",
        "search",
        "--input",
        "{}",
        "--timeout",
        "1s",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(outputText(consoleError)).toContain("timed out after 1s");
  });
});
