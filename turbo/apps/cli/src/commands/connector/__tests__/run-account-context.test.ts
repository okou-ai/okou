import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import type { CustomConnectorMcpResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  catalogItem,
  stubConnectorCatalog,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { server } from "../../../mocks/server";
import { listCommand } from "../list";
import { RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES } from "../run-account-context";
import { statusCommand } from "../status";

const AGENT_ID = "550e8400-e29b-41d4-a716-446655440000";
const PINNED_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const DELETED_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function accountMetadata(
  connectionId: string,
  target: {
    readonly kind: "builtin";
    readonly connectorSlug: string;
  },
) {
  return {
    kind: "available" as const,
    connectionId,
    target,
    authMethod: "oauth" as const,
    displayName: "Thread-selected work account",
    externalId: "provider-account-7",
    externalUsername: "work-user",
    externalEmail: "work@example.test",
    connectionStatus: "connected" as const,
    reconnectReason: null,
  };
}

function customMcpConnector(): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.example.test/server",
    transport: "streamable-http",
    prefixTemplates: [],
    fields: [],
    headerInjections: [],
    queryInjections: [],
    authMode: "manual",
    storageVersion: 1,
    connected: true,
    missingRequiredFields: [],
    configuredFieldKeys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("run connector account inspection", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});
  let directory = "";
  let contextPath = "";

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "okou-run-account-"));
    contextPath = join(directory, "context.json");
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", contextPath);
    listCommand.setOptionValue("agent", undefined);
    listCommand.setOptionValue("json", false);
    statusCommand.setOptionValue("agent", undefined);
    statusCommand.setOptionValue("json", false);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  function writeContext(targets: readonly object[]): void {
    writeFileSync(
      contextPath,
      JSON.stringify({ schemaVersion: 1, targets }),
      "utf8",
    );
  }

  it.each([
    { selector: "omitted", args: [], setup: {} },
    { selector: "matching", args: ["--agent", AGENT_ID], setup: {} },
    {
      selector: "prepared metadata",
      args: [],
      setup: {
        setupStatus: "incomplete",
        missingRequiredFields: ["token"],
        configuredFieldKeys: [],
      },
    },
  ])(
    "shows the exact run account in list, status, and JSON with $selector --agent",
    async ({ args, setup }) => {
      const inspectedBodies: unknown[] = [];
      writeContext([
        {
          kind: "builtin",
          connectorSlug: "github",
          connectionId: PINNED_CONNECTION_ID,
        },
      ]);
      server.use(
        stubConnectorCatalog([
          catalogItem({ connectorSlug: "github", label: "GitHub" }),
        ]),
        stubCustomConnectors([]),
        http.post(
          "http://localhost:3000/api/connector-accounts/inspect",
          async ({ request }) => {
            const raw = await request.json();
            inspectedBodies.push(raw);
            const body = connectorAccountsContract.inspect.body.parse(raw);
            return HttpResponse.json({
              results: body.selections.map((selection) => {
                if (selection.target.kind !== "builtin") {
                  throw new Error("Expected a built-in selection");
                }
                return {
                  ...accountMetadata(selection.connectionId, selection.target),
                  ...setup,
                };
              }),
            });
          },
        ),
      );

      await listCommand.parseAsync(["node", "cli", ...args]);
      let output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("ACCOUNT USED BY THIS RUN");
      expect(output).toContain("Thread-selected work account");
      expect(output).toContain(PINNED_CONNECTION_ID);
      expect(output).not.toContain("CONNECTED AS");

      mockConsoleLog.mockClear();
      await statusCommand.parseAsync(["node", "cli", "github", ...args]);
      output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("Account Used:");
      expect(output).toContain("Thread-selected work account");
      expect(output).toContain(PINNED_CONNECTION_ID);
      expect(output).toContain("Current Status:");

      mockConsoleLog.mockClear();
      await statusCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--json",
        ...args,
      ]);
      const json: unknown = JSON.parse(
        String(mockConsoleLog.mock.calls[0]?.[0]),
      );
      expect(json).toStrictEqual(
        expect.objectContaining({
          context: "run",
          state: "available",
          connector: expect.objectContaining({
            target: { kind: "builtin", connectorSlug: "github" },
            connectorType: "builtin",
            definitionAvailable: true,
            account: expect.objectContaining({
              state: "available",
              connectionId: PINNED_CONNECTION_ID,
              label: "Thread-selected work account",
              metadata: expect.objectContaining(setup),
            }),
          }),
        }),
      );
      expect(JSON.stringify(json)).not.toContain("sk-");
      expect(inspectedBodies).toHaveLength(3);
      expect(inspectedBodies[0]).toStrictEqual({
        selections: [
          {
            connectionId: PINNED_CONNECTION_ID,
            target: { kind: "builtin", connectorSlug: "github" },
          },
        ],
      });
    },
  );

  it("retains deleted IDs and source-less targets without choosing a sibling", async () => {
    writeContext([
      {
        kind: "builtin",
        connectorSlug: "github",
        connectionId: DELETED_CONNECTION_ID,
      },
      {
        kind: "builtin",
        connectorSlug: "slack",
        connectionId: null,
      },
    ]);
    server.use(
      stubConnectorCatalog([
        catalogItem({ connectorSlug: "github" }),
        catalogItem({ connectorSlug: "slack" }),
      ]),
      stubCustomConnectors([]),
      http.post(
        "http://localhost:3000/api/connector-accounts/inspect",
        async ({ request }) => {
          const body = connectorAccountsContract.inspect.body.parse(
            await request.json(),
          );
          expect(body.selections).toHaveLength(1);
          return HttpResponse.json({
            results: body.selections.map((selection) => {
              return { kind: "unavailable" as const, ...selection };
            }),
          });
        },
      ),
    );

    await listCommand.parseAsync(["node", "cli"]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(DELETED_CONNECTION_ID);
    expect(output).toContain("metadata unavailable or deleted");
    expect(output).toContain("unavailable for this run");
    expect(output).not.toContain("default");
  });

  it("treats an empty run projection as known empty without enrichment", async () => {
    let inspectionRequests = 0;
    writeContext([]);
    server.use(
      stubConnectorCatalog([]),
      stubCustomConnectors([]),
      http.post("http://localhost:3000/api/connector-accounts/inspect", () => {
        inspectionRequests += 1;
        return HttpResponse.json({ results: [] });
      }),
    );

    await listCommand.parseAsync(["node", "cli", "--json"]);

    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toStrictEqual(
      {
        context: "run",
        state: "available",
        connectors: [],
      },
    );
    expect(inspectionRequests).toBe(0);
  });

  it.each(["slug", "uuid", "qualified", "name"] as const)(
    "preserves pinned HTTP and MCP accounts for a %s selector",
    async (form) => {
      const httpConnector = customConnector();
      const mcpConnector = customMcpConnector();
      const httpConnectionId = "33333333-3333-4333-8333-333333333334";
      const mcpConnectionId = "44444444-4444-4444-8444-444444444445";
      writeContext([
        {
          kind: "custom",
          customConnectorId: httpConnector.id,
          connectionId: httpConnectionId,
        },
        {
          kind: "custom",
          customConnectorId: mcpConnector.id,
          connectionId: mcpConnectionId,
        },
      ]);
      server.use(
        stubConnectorCatalog([]),
        stubCustomConnectors([httpConnector, mcpConnector]),
        http.post(
          "http://localhost:3000/api/connector-accounts/inspect",
          async ({ request }) => {
            const body = connectorAccountsContract.inspect.body.parse(
              await request.json(),
            );
            return HttpResponse.json({
              results: body.selections.map((selection) => {
                return { kind: "unavailable" as const, ...selection };
              }),
            });
          },
        ),
      );

      await listCommand.parseAsync(["node", "cli"]);
      let output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain(httpConnector.slug);
      expect(output).toContain(httpConnectionId);
      expect(output).toContain(mcpConnector.slug);
      expect(output).toContain(mcpConnectionId);

      mockConsoleLog.mockClear();
      const selectors = {
        slug: mcpConnector.slug,
        uuid: mcpConnector.id,
        qualified: `custom:${mcpConnector.id}`,
        name: mcpConnector.displayName,
      };
      await statusCommand.parseAsync(["node", "cli", selectors[form]]);
      output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain(mcpConnectionId);
      expect(output).toContain("Current Status:");

      mockConsoleLog.mockClear();
      await listCommand.parseAsync(["node", "cli", "--json"]);
      const json: unknown = JSON.parse(
        mockConsoleLog.mock.calls.flat().join("\n"),
      );
      expect(json).toMatchObject({
        context: "run",
        connectors: [
          {
            target: { kind: "custom", customConnectorId: httpConnector.id },
            connectorType: "custom-http",
            definitionAvailable: true,
            account: {
              state: "metadata-unavailable",
              connectionId: httpConnectionId,
            },
          },
          {
            target: { kind: "custom", customConnectorId: mcpConnector.id },
            connectorType: "custom-mcp",
            definitionAvailable: true,
            account: {
              state: "metadata-unavailable",
              connectionId: mcpConnectionId,
            },
          },
        ],
      });
      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
    },
  );

  it("retains a missing custom definition's UUID with an explicitly unknown subtype", async () => {
    const customConnectorId = "33333333-3333-4333-8333-333333333333";
    writeContext([{ kind: "custom", customConnectorId, connectionId: null }]);
    server.use(stubConnectorCatalog([]), stubCustomConnectors([]));
    await statusCommand.parseAsync([
      "node",
      "cli",
      `custom:${customConnectorId}`,
      "--json",
    ]);
    const json: unknown = JSON.parse(
      mockConsoleLog.mock.calls.flat().join("\n"),
    );
    expect(json).toMatchObject({
      context: "run",
      connector: {
        target: { kind: "custom", customConnectorId },
        connectorType: null,
        definitionAvailable: false,
        account: { state: "not-admitted", connectionId: null },
      },
    });
  });

  it("retains exact IDs when the enrichment route is unavailable", async () => {
    writeContext([
      {
        kind: "builtin",
        connectorSlug: "github",
        connectionId: PINNED_CONNECTION_ID,
      },
    ]);
    server.use(
      stubConnectorCatalog([catalogItem({ connectorSlug: "github" })]),
      stubCustomConnectors([]),
      http.post("http://localhost:3000/api/connector-accounts/inspect", () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Resource not found" } },
          { status: 404 },
        );
      }),
    );

    await listCommand.parseAsync(["node", "cli"]);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(PINNED_CONNECTION_ID);
    expect(output).toContain("metadata unavailable");
  });

  it("chunks more than one bounded API batch in stable order", async () => {
    const targets = Array.from({ length: 257 }, (_, index) => {
      const serial = index + 1;
      return {
        kind: "builtin" as const,
        connectorSlug: `connector-${serial}`,
        connectionId: `00000000-0000-4000-8000-${serial
          .toString(16)
          .padStart(12, "0")}`,
      };
    });
    const batchSizes: number[] = [];
    writeContext(targets);
    server.use(
      stubConnectorCatalog([]),
      stubCustomConnectors([]),
      http.post(
        "http://localhost:3000/api/connector-accounts/inspect",
        async ({ request }) => {
          const body = connectorAccountsContract.inspect.body.parse(
            await request.json(),
          );
          batchSizes.push(body.selections.length);
          return HttpResponse.json({
            results: body.selections.map((selection) => {
              return { kind: "unavailable" as const, ...selection };
            }),
          });
        },
      ),
    );

    await listCommand.parseAsync(["node", "cli", "--json"]);
    const json = z
      .object({
        connectors: z.array(
          z
            .object({
              slug: z.string(),
              account: z.object({ connectionId: z.string() }).passthrough(),
            })
            .passthrough(),
        ),
      })
      .passthrough()
      .parse(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0])));
    expect(batchSizes).toStrictEqual([256, 1]);
    expect(json.connectors).toHaveLength(257);
    expect(json.connectors[0]?.slug).toBe("connector-1");
    expect(json.connectors[256]?.slug).toBe("connector-257");
    expect(json.connectors[256]?.account.connectionId).toBe(
      targets[256]?.connectionId,
    );
  });

  it.each([
    ["malformed", "{"],
    ["unsupported-version", JSON.stringify({ schemaVersion: 2, targets: [] })],
    [
      "duplicate-target",
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            kind: "builtin",
            connectorSlug: "github",
            connectionId: PINNED_CONNECTION_ID,
          },
          {
            kind: "builtin",
            connectorSlug: "github",
            connectionId: DELETED_CONNECTION_ID,
          },
        ],
      }),
    ],
    [
      "malformed",
      JSON.stringify({
        schemaVersion: 1,
        targets: [],
        credential: "must-not-be-rendered",
      }),
    ],
  ])("fails closed for %s context files", async (reason, contents) => {
    writeFileSync(contextPath, contents, "utf8");

    await listCommand.parseAsync(["node", "cli", "--json"]);
    const output = String(mockConsoleLog.mock.calls[0]?.[0]);
    const json = z
      .object({ state: z.string(), reason: z.string() })
      .passthrough()
      .parse(JSON.parse(output));
    expect(json).toMatchObject({ state: "unavailable", reason });
    expect(output).not.toContain("must-not-be-rendered");
  });

  it("fails closed for oversized and unreadable context paths", async () => {
    writeFileSync(contextPath, "", "utf8");
    truncateSync(contextPath, RUN_CONNECTOR_ACCOUNT_CONTEXT_MAX_BYTES + 1);
    await listCommand.parseAsync(["node", "cli", "--json"]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toMatchObject(
      {
        state: "unavailable",
        reason: "oversized",
      },
    );

    mockConsoleLog.mockClear();
    vi.stubEnv("OKOU_CONNECTOR_ACCOUNT_CONTEXT_FILE", directory);
    listCommand.setOptionValue("json", false);
    await listCommand.parseAsync(["node", "cli", "--json"]);
    expect(JSON.parse(String(mockConsoleLog.mock.calls[0]?.[0]))).toMatchObject(
      {
        state: "unavailable",
        reason: "unreadable",
      },
    );
  });
});
