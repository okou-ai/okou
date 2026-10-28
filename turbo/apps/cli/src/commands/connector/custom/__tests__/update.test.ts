import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomConnectorMcpResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import { server } from "../../../../mocks/server";
import {
  customConnector,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../index";
import { updateCustomConnectorCommand } from "../update";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";

function buildOkouToken(
  capabilities: readonly string[] = ["connector:write"],
): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      userId: "user-1",
      runId: "run-1",
      orgId: "org-1",
      scope: "okou",
      capabilities,
      iat: 1,
      exp: 2,
    }),
  ).toString("base64url");
  return `vm0_sandbox_${header}.${payload}.test-signature`;
}

function manualMcpDefinition() {
  return {
    kind: "mcp",
    displayName: "Acme MCP Updated",
    endpoint: "https://mcp.acme.example/v2/server",
    transport: "streamable-http",
    fields: [
      {
        key: "secret",
        label: "API Token",
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
  } as const;
}

function oauthMcpDefinition() {
  return {
    kind: "mcp",
    displayName: "Acme OAuth MCP Updated",
    endpoint: "https://oauth-mcp.acme.example/server",
    transport: "streamable-http",
    fields: [],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{oauth.access_token}}",
      },
    ],
    queryInjections: [],
    authMode: "oauth",
    oauthConfig: {
      providerAdapter: "standard",
      clientId: "oauth-client-id",
      authorizationUrl: "https://acme.example/oauth/authorize",
      tokenUrl: "https://acme.example/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read"],
      authorizationParams: {},
    },
  } as const;
}

function mcpResponse(
  definition: ReturnType<typeof manualMcpDefinition>,
): CustomConnectorMcpResponse {
  return {
    kind: "mcp",
    id: CONNECTOR_ID,
    slug: "_acme-mcp",
    displayName: definition.displayName,
    endpoint: definition.endpoint,
    transport: "streamable-http",
    prefixTemplates: [],
    fields: [...definition.fields],
    headerInjections: [...definition.headerInjections],
    queryInjections: [],
    authMode: definition.authMode,
    permissionBundleRef: null,
    storageVersion: 1,

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  };
}

describe("okou connector custom update", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    tempDir = mkdtempSync(join(tmpdir(), "custom-connector-update-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", buildOkouToken());
  });

  afterEach(() => {
    mockConsoleLog.mockClear();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeDefinition(value: unknown): string {
    const path = join(tempDir, "connector.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  it.each([
    CONNECTOR_ID,
    `custom:${CONNECTOR_ID}`,
    "_acme-mcp",
    "custom:_acme-mcp",
    "Acme MCP Updated",
  ])("updates an MCP definition selected by %s", async (selector) => {
    const definition = manualMcpDefinition();
    const definitionPath = writeDefinition(definition);
    if (selector !== CONNECTOR_ID) {
      server.use(stubCustomConnectors([mcpResponse(definition)]));
    }
    let updateBody: unknown;
    server.use(
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        async ({ request }) => {
          updateBody = await request.json();
          return HttpResponse.json(mcpResponse(definition));
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "update",
      selector,
      "--file",
      definitionPath,
    ]);

    expect(updateBody).toStrictEqual(definition);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(
      'Custom connector "Acme MCP Updated" updated',
    );
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain(CONNECTOR_ID);
    expect(mockConsoleLog.mock.calls.flat().join("\n")).toContain("_acme-mcp");
  });

  it("updates an HTTP connector to an HTTP prefix by its exact slug", async () => {
    const connector = customConnector({ id: CONNECTOR_ID });
    const definition = {
      kind: connector.kind,
      displayName: "Updated HTTP connector",
      prefixTemplates: ["http://api.acme.example:8080/v2/"],
      fields: connector.fields,
      headerInjections: connector.headerInjections,
      queryInjections: connector.queryInjections,
      authMode: connector.authMode,
    };
    let updateBody: unknown;
    server.use(
      stubCustomConnectors([connector]),
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        async ({ request }) => {
          updateBody = await request.json();
          return HttpResponse.json({ ...connector, ...definition });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "update",
      connector.slug,
      "--file",
      writeDefinition(definition),
      "--json",
    ]);

    expect(updateBody).toStrictEqual(definition);
    expect(
      JSON.parse(mockConsoleLog.mock.calls.flat().join("\n")),
    ).toMatchObject({
      id: CONNECTOR_ID,
      slug: connector.slug,
      displayName: definition.displayName,
    });
  });

  it.each(["unknown", "ambiguous"])(
    "rejects an %s slug before updating a connector",
    async (scenario) => {
      const definition = manualMcpDefinition();
      server.use(
        stubCustomConnectors(
          scenario === "unknown"
            ? []
            : [
                mcpResponse(definition),
                {
                  ...mcpResponse(definition),
                  id: "44444444-4444-4444-8444-444444444444",
                },
              ],
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
            "update",
            "_acme-mcp",
            "--file",
            writeDefinition(definition),
          ]),
        ).rejects.toThrow("process.exit called");
        const message = error.mock.calls.flat().join("\n");
        expect(message).toContain(
          scenario === "unknown" ? "Unknown or unavailable" : "Ambiguous",
        );
        if (scenario === "unknown") {
          expect(message).toContain("okou connector custom list");
        } else {
          expect(message).toContain(`custom:${CONNECTOR_ID}`);
          expect(message).toContain(
            "custom:44444444-4444-4444-8444-444444444444",
          );
        }
        expect(mockConsoleLog).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
        exit.mockRestore();
      }
    },
  );

  it("allows an OAuth update to omit the current client secret", async () => {
    const definition = oauthMcpDefinition();
    const definitionPath = writeDefinition(definition);
    let updateBody: unknown;
    server.use(
      http.put(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
        async ({ request }) => {
          updateBody = await request.json();
          return HttpResponse.json({
            ...mcpResponse(manualMcpDefinition()),
            displayName: definition.displayName,
            endpoint: definition.endpoint,
            fields: [],
            headerInjections: [...definition.headerInjections],
            authMode: "oauth",
            oauthConfig: definition.oauthConfig,
            configuredFieldKeys: [],
          });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "update",
      CONNECTOR_ID,
      "--file",
      definitionPath,
      "--json",
    ]);

    expect(updateBody).toStrictEqual(definition);
    expect(updateBody).not.toHaveProperty("oauthConfig.clientSecret");
  });

  it.each([CONNECTOR_ID, "_acme-mcp"])(
    "rejects hybrid protocol files before resolving %s",
    async (selector) => {
      const definitionPath = writeDefinition({
        ...manualMcpDefinition(),
        prefixTemplates: ["https://api.acme.example/"],
      });
      let requests = 0;
      let inventoryRequests = 0;
      server.use(
        http.get("http://localhost:3000/api/custom-connectors", () => {
          inventoryRequests += 1;
          return HttpResponse.json({
            connectors: [mcpResponse(manualMcpDefinition())],
          });
        }),
        http.put(
          `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}`,
          () => {
            requests += 1;
            return HttpResponse.json({}, { status: 500 });
          },
        ),
      );
      const mockConsoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
        return undefined as never;
      });

      try {
        await customConnectorCommand.parseAsync([
          "node",
          "okou",
          "update",
          selector,
          "--file",
          definitionPath,
        ]);

        expect(requests).toBe(0);
        expect(inventoryRequests).toBe(0);
        expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
          "Invalid configuration input",
        );
        expect(mockExit).toHaveBeenCalledWith(1);
      } finally {
        mockConsoleError.mockRestore();
        mockExit.mockRestore();
      }
    },
  );

  it("requires write capability before resolving a slug", async () => {
    vi.stubEnv("OKOU_TOKEN", buildOkouToken([]));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    try {
      await expect(
        customConnectorCommand.parseAsync([
          "node",
          "okou",
          "update",
          "_acme-mcp",
          "--file",
          writeDefinition(manualMcpDefinition()),
        ]),
      ).rejects.toThrow("process.exit called");
      expect(error.mock.calls.flat().join("\n")).toContain(
        "Custom connector update is not enabled for this agent run",
      );
      expect(mockConsoleLog).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      exit.mockRestore();
    }
  });

  it("documents OAuth secret preservation", () => {
    let help = "";
    updateCustomConnectorCommand.configureOutput({
      writeOut: (value) => {
        help += value;
      },
    });
    updateCustomConnectorCommand.outputHelp();

    expect(help).toContain("may omit oauthConfig.clientSecret");
    expect(help).toContain("Never include an end-user token");
  });
});
