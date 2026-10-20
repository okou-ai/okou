import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomConnectorMcpResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import { server } from "../../../../mocks/server";
import {
  customConnector,
  customMcpConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../index";
import {
  connectorAccount,
  stubConnectorAccounts,
  stubConnectedConnectors,
} from "../../../__tests__/helpers/connector-accounts";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";

describe("okou connector custom readers", () => {
  const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    server.use(stubConnectorAccounts([]), stubConnectedConnectors());
    for (const command of customConnectorCommand.commands) {
      command.setOptionValue("agent", undefined);
      command.setOptionValue("json", false);
    }
  });

  afterEach(() => {
    consoleLog.mockClear();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  it("emits current org JSON with protocol and grants even from inside a run", async () => {
    const connector = customConnector({
      connectedAccountId: "55555555-5555-4555-8555-555555555555",
    });
    const mcp = customMcpConnector();
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    server.use(
      stubConnectedConnectors([], [connector]),
      stubCustomConnectors([connector, mcp]),
      http.get(`http://localhost:3000/api/agents/${AGENT_ID}`, () => {
        return HttpResponse.json({
          agentId: AGENT_ID,
          ownerId: "owner-1",
          description: null,
          displayName: "Maya",
          sound: null,
          avatarUrl: null,
        });
      }),
      stubAgentCustomConnectors([
        { customConnectorId: connector.id, permissionNames: [] },
      ]),
    );
    chalk.level = 3;
    await customConnectorCommand.parseAsync(["node", "okou", "list", "--json"]);
    const output = consoleLog.mock.calls.flat().join("\n");
    const json: unknown = JSON.parse(output);
    expect(json).toMatchObject({
      context: "current",
      agent: { agentId: AGENT_ID },
      connectors: [
        {
          kind: "http",
          connectorType: "custom-http",
          target: { kind: "custom", customConnectorId: connector.id },
          hasSavedAccounts: true,
          authorized: true,
        },
        {
          kind: "mcp",
          connectorType: "custom-mcp",
          target: { kind: "custom", customConnectorId: mcp.id },
          authorized: false,
        },
      ],
    });
    expect(consoleLog).toHaveBeenCalledTimes(1);
    expect(output).not.toContain("\u001b[");
  });

  it("returns an empty org inventory as JSON", async () => {
    server.use(stubCustomConnectors([]));
    await customConnectorCommand.parseAsync(["node", "okou", "list", "--json"]);
    const json: unknown = JSON.parse(consoleLog.mock.calls.flat().join("\n"));
    expect(json).toMatchObject({
      context: "current",
      agent: null,
      connectors: [],
    });
  });

  it.each([customConnector(), customMcpConnector()])(
    "uses canonical member accounts when the $kind definition omits old projections",
    async (definition) => {
      const accountId = "55555555-5555-4555-8555-555555555555";
      const target = {
        kind: "custom" as const,
        customConnectorId: definition.id,
      };
      server.use(
        stubConnectorAccounts([connectorAccount(target, { id: accountId })]),
        stubCustomConnectors([definition]),
        http.get(
          `http://localhost:3000/api/custom-connectors/${definition.id}`,
          () => {
            return HttpResponse.json(definition);
          },
        ),
      );

      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "status",
        definition.id,
        "--json",
      ]);

      const json: unknown = JSON.parse(consoleLog.mock.calls.flat().join("\n"));
      expect(json).toMatchObject({
        context: "current",
        connector: {
          id: definition.id,
          kind: definition.kind,
          target: { kind: "custom", customConnectorId: definition.id },
          integrationManaged: false,
          connectionId: accountId,
          memberStatus: "connected",
          accountSummary: {
            accountCount: 1,
            defaultConnection: { id: accountId, setupStatus: "complete" },
          },
        },
      });
    },
  );

  it.each(
    [customConnector(), customMcpConnector()].flatMap((connector) => {
      return [
        connector.id,
        connector.slug,
        `custom:${connector.id}`,
        connector.displayName,
      ].map((selector) => {
        return { connector, selector };
      });
    }),
  )(
    "exposes $connector.kind definition details selected by $selector through JSON",
    async ({ connector, selector }) => {
      server.use(
        stubCustomConnectors([connector]),
        http.get(
          `http://localhost:3000/api/custom-connectors/${connector.id}`,
          () => {
            return HttpResponse.json(connector);
          },
        ),
      );
      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "status",
        selector,
        "--json",
      ]);
      const json: unknown = JSON.parse(consoleLog.mock.calls.flat().join("\n"));
      expect(json).toMatchObject({
        context: "current",
        state: "available",
        target: { kind: "custom", customConnectorId: connector.id },
        connector: {
          id: connector.id,
          slug: connector.slug,
          kind: connector.kind,
          displayName: connector.displayName,
          authMode: connector.authMode,
          connectorType: `custom-${connector.kind}`,
          authorized: null,
        },
      });
    },
  );

  it("preserves an unavailable definition's target and nonzero exit in JSON", async () => {
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(
            { error: { code: "NOT_FOUND", message: "Not found" } },
            { status: 404 },
          );
        },
      ),
    );
    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      CONNECTOR_ID,
      "--json",
    ]);
    const json: unknown = JSON.parse(consoleLog.mock.calls.flat().join("\n"));
    expect(json).toMatchObject({
      context: "current",
      target: { kind: "custom", customConnectorId: CONNECTOR_ID },
      state: "unavailable",
      connector: null,
    });
    expect(process.exitCode).toBe(1);
  });

  it("renders tagged HTTP connectors in list output", async () => {
    const connector = customConnector();
    server.use(
      http.get("http://localhost:3000/api/custom-connectors", () => {
        return HttpResponse.json({
          connectors: [connector],
        });
      }),
    );

    await customConnectorCommand.parseAsync(["node", "okou", "list"]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("KIND");
    expect(output).toContain("SLUG");
    expect(output).toContain(connector.id);
    expect(output).toContain(connector.slug);
    expect(output).toContain("Acme Search");
    expect(output).toContain("http");
  });

  it.each([
    { context: "non-run", runAgent: undefined, args: ["--agent", AGENT_ID] },
    { context: "run with omitted selector", runAgent: AGENT_ID, args: [] },
    {
      context: "run with matching selector",
      runAgent: AGENT_ID,
      args: ["--agent", AGENT_ID],
    },
  ])(
    "renders custom grants in list and status for $context",
    async ({ runAgent, args }) => {
      vi.stubEnv("OKOU_AGENT_ID", runAgent);
      const connector = customConnector();
      server.use(
        stubCustomConnectors([connector]),
        http.get(
          `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
          () => {
            return HttpResponse.json(connector);
          },
        ),
        http.get(`http://localhost:3000/api/agents/${AGENT_ID}`, () => {
          return HttpResponse.json({
            agentId: AGENT_ID,
            ownerId: "owner-1",
            description: null,
            displayName: "Maya",
            sound: null,
            avatarUrl: null,
          });
        }),
        stubAgentCustomConnectors([
          {
            customConnectorId: connector.id,
            permissionNames: ["chat:write"],
          },
        ]),
      );

      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "list",
        ...args,
      ]);

      const output = consoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("AUTHORIZED FOR Maya");
      const connectorRow = (consoleLog.mock.calls.flat() as string[]).find(
        (line) => {
          return line.startsWith(connector.id);
        },
      );
      expect(connectorRow).toMatch(/✓$/u);

      consoleLog.mockClear();
      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "status",
        CONNECTOR_ID,
        ...args,
      ]);

      const status = consoleLog.mock.calls.flat().join("\n");
      expect(status).toContain("Custom connector: Acme Search");
      expect(status).toMatch(/Authorized:\s+yes/u);
    },
  );

  it.each([
    CONNECTOR_ID,
    `custom:${CONNECTOR_ID}`,
    "_acme-search",
    "_ACME-SEARCH",
    "custom:_acme-search",
    "Acme Search",
  ])("shows HTTP status selected by %s", async (selector) => {
    const connector = customConnector();
    if (selector !== CONNECTOR_ID) {
      server.use(
        stubCustomConnectors([
          customConnector({
            id: AGENT_ID,
            slug: "_acme-search-extra",
            displayName: "Another connector",
          }),
          connector,
        ]),
      );
    }
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      selector,
    ]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(`ID:               ${CONNECTOR_ID}`);
    expect(output).toContain("Slug:             _acme-search");
    expect(output).toContain("Kind:             http");
    expect(output).toContain("Prefixes:         https://api.acme.test/v1/");
  });

  it.each([
    CONNECTOR_ID,
    `custom:${CONNECTOR_ID}`,
    "_acme-mcp",
    "custom:_acme-mcp",
    "Acme MCP",
  ])("shows MCP status selected by %s", async (selector) => {
    const connector = {
      kind: "mcp",
      id: CONNECTOR_ID,
      slug: "_acme-mcp",
      displayName: "Acme MCP",
      endpoint: "https://mcp.acme.test/server",
      transport: "streamable-http",
      prefixTemplates: [],
      fields: [
        {
          key: "secret",
          label: "Secret",
          kind: "secret",
          required: true,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.secret}}",
        },
      ],
      queryInjections: [],
      authMode: "manual",
      permissionBundleRef: null,
      storageVersion: 1,

      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    } satisfies CustomConnectorMcpResponse;
    if (selector !== CONNECTOR_ID) {
      server.use(stubCustomConnectors([connector]));
    }
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        () => {
          return HttpResponse.json(connector);
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "status",
      selector,
    ]);

    const output = consoleLog.mock.calls.flat().join("\n");
    expect(output).toContain(`ID:               ${CONNECTOR_ID}`);
    expect(output).toContain("Slug:             _acme-mcp");
    expect(output).toContain("Kind:             mcp");
    expect(output).toContain("Transport:        streamable-http");
    expect(output).toContain("Endpoint:         https://mcp.acme.test/server");
    expect(output).not.toContain("Prefixes:");
  });

  it.each([CONNECTOR_ID, "_acme-search"])(
    "reports recovery guidance when status target %s is no longer available",
    async (selector) => {
      server.use(
        stubCustomConnectors([customConnector()]),
        http.get(
          `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
          () => {
            return HttpResponse.json(
              { error: { code: "NOT_FOUND", message: "Connector not found" } },
              { status: 404 },
            );
          },
        ),
      );
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const exit = vi.spyOn(process, "exit").mockImplementation(() => {
        throw new Error("process.exit called");
      });
      try {
        await expect(
          customConnectorCommand.parseAsync([
            "node",
            "okou",
            "status",
            selector,
          ]),
        ).rejects.toThrow("process.exit called");

        const output = error.mock.calls.flat().join("\n");
        expect(output).toContain(`Custom connector not found: ${CONNECTOR_ID}`);
        expect(output).toContain("okou connector custom list");
        expect(consoleLog).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        exit.mockRestore();
      }
    },
  );

  it.each([
    ["_removed-slug", "Unknown or unavailable custom connector selector"],
    ["Acme", "Unknown or unavailable custom connector selector"],
    ["acme search", "Unknown or unavailable custom connector selector"],
    ["github", "Unknown or unavailable custom connector selector"],
    ["builtin:github", "Expected a custom connector"],
  ])("rejects unresolved status selector %s", async (selector, message) => {
    server.use(stubCustomConnectors([customConnector()]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    try {
      await expect(
        customConnectorCommand.parseAsync(["node", "okou", "status", selector]),
      ).rejects.toThrow("process.exit called");
      expect(error.mock.calls.flat().join("\n")).toContain(message);
      expect(error.mock.calls.flat().join("\n")).toContain(
        "okou connector custom list",
      );
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });
});
