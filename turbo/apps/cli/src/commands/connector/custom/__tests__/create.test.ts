import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import chalk from "chalk";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import { customConnector } from "../../../__tests__/helpers/custom-connectors";
import { createCustomConnectorCommand } from "../create";
import { customConnectorCommand } from "../index";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";

function buildOkouToken(capabilities: readonly string[]): string {
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

function manualDefinition() {
  return {
    displayName: "Acme API",
    prefixTemplates: ["https://api.acme.example/v1/"],
    fields: [
      {
        key: "secret",
        label: "API Token",
        kind: "secret",
        required: true,
        description: "API credential",
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

function oauthDefinition() {
  return {
    displayName: "Acme OAuth API",
    prefixTemplates: ["https://api.acme.example/v1/"],
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
      clientSecret: "oauth-client-secret",
      authorizationUrl: "https://acme.example/oauth/authorize",
      tokenUrl: "https://acme.example/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      pkceMethod: "S256",
      scopes: ["read", "write"],
      authorizationParams: {},
    },
  } as const;
}

function manualMcpDefinition() {
  return {
    kind: "mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.acme.example/server",
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

describe("okou connector custom create", () => {
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  let tempDir: string;

  beforeEach(() => {
    chalk.level = 0;
    createCustomConnectorCommand.setOptionValue("json", false);
    createCustomConnectorCommand.setOptionValue("callbackPrompt", undefined);
    tempDir = mkdtempSync(join(tmpdir(), "custom-connector-create-"));
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["connector:write"]));
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");
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

  it("creates only the API connector definition", async () => {
    const definitionPath = writeDefinition(manualDefinition());
    let createBody: unknown;
    const created = customConnector({
      id: CONNECTOR_ID,
      displayName: "Acme API",
      prefixTemplates: ["https://api.acme.example/v1/"],
      fields: [...manualDefinition().fields],
      headerInjections: [...manualDefinition().headerInjections],
    });
    server.use(
      http.post(
        "http://localhost:3000/api/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(created, { status: 201 });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "create",
      "--file",
      definitionPath,
    ]);

    expect(createBody).toStrictEqual(manualDefinition());
    expect(createBody).not.toHaveProperty("values");
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('Custom connector "Acme API" created');
    expect(output).toContain("awaiting connection");
    expect(output).toContain(
      `Connect it at: [Connect Acme API](http://localhost:3000/connectors/_acme-search/connect?agentId=${AGENT_ID})`,
    );
  });

  it("creates only an OAuth definition and leaves authorization to Connect", async () => {
    const definitionPath = writeDefinition(oauthDefinition());
    let createBody: unknown;
    let oauthStartRequests = 0;
    const created = customConnector({
      id: CONNECTOR_ID,
      displayName: "Acme OAuth API",
      authMode: "oauth",
      prefixTemplates: ["https://api.acme.example/v1/"],
      fields: [],
      headerInjections: [...oauthDefinition().headerInjections],
      oauthConfig: {
        providerAdapter: "standard",
        clientId: "oauth-client-id",
        authorizationUrl: "https://acme.example/oauth/authorize",
        tokenUrl: "https://acme.example/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        pkceMethod: "S256",
        scopes: ["read", "write"],
        authorizationParams: {},
      },
    });
    server.use(
      http.post(
        "http://localhost:3000/api/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(created, { status: 201 });
        },
      ),
      http.post(
        `http://localhost:3000/api/custom-connectors/${CONNECTOR_ID}/oauth2/start`,
        () => {
          oauthStartRequests += 1;
          return HttpResponse.json({
            authorizationUrl: "https://acme.example/oauth/authorize",
          });
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "create",
      "--file",
      definitionPath,
    ]);

    expect(createBody).toStrictEqual(oauthDefinition());
    expect(createBody).not.toHaveProperty("values");
    expect(oauthStartRequests).toBe(0);
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain('Custom connector "Acme OAuth API" created');
    expect(output).toContain("Authentication: oauth");
    expect(output).toContain(
      `Connect it at: [Connect Acme OAuth API](http://localhost:3000/connectors/_acme-search/connect?agentId=${AGENT_ID})`,
    );
    expect(output).not.toContain("oauth-client-secret");
  });

  it("creates an explicit Streamable HTTP MCP definition with a connection callback", async () => {
    const definitionPath = writeDefinition(manualMcpDefinition());
    let createBody: unknown;
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    server.use(
      http.post(
        "http://localhost:3000/api/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(
            {
              kind: "mcp",
              id: CONNECTOR_ID,
              slug: "_acme-mcp",
              displayName: "Acme MCP",
              endpoint: "https://mcp.acme.example/server",
              transport: "streamable-http",
              prefixTemplates: [],
              fields: [...manualMcpDefinition().fields],
              headerInjections: [...manualMcpDefinition().headerInjections],
              queryInjections: [],
              authMode: "manual",
              permissionBundleRef: null,
              storageVersion: 1,

              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
            { status: 201 },
          );
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "create",
      "--file",
      definitionPath,
      "--json",
      "--callback-prompt",
      "Verify MCP tools",
    ]);

    expect(createBody).toStrictEqual(manualMcpDefinition());
    const output: unknown = JSON.parse(
      mockConsoleLog.mock.calls.flat().join("\n"),
    );
    expect(output).toMatchObject({
      id: CONNECTOR_ID,
      kind: "mcp",
      connectUrl: `http://localhost:3000/connectors/_acme-mcp/connect?agentId=${AGENT_ID}&threadId=${THREAD_ID}&callbackPrompt=Verify+MCP+tools`,
    });
  });

  it("rejects files containing credential values", async () => {
    const definitionPath = writeDefinition({
      ...manualDefinition(),
      values: [{ key: "secret", kind: "secret", value: "plaintext-secret" }],
    });
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
        "create",
        "--file",
        definitionPath,
      ]);

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "Invalid configuration input",
      );
      expect(mockConsoleError.mock.calls.flat().join("\n")).not.toContain(
        "plaintext-secret",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
      expect(mockConsoleLog).not.toHaveBeenCalled();
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("creates a manual definition with declared secret and variable fields", async () => {
    const definition = {
      ...manualDefinition(),
      fields: [
        {
          ...manualDefinition().fields[0],
          key: "api_token",
        },
        {
          key: "account_id",
          label: "Account ID",
          kind: "variable",
          required: false,
        },
      ],
      headerInjections: [
        {
          name: "Authorization",
          valueTemplate: "Bearer {{secrets.api_token}}",
        },
      ],
      queryInjections: [
        {
          name: "account_id",
          valueTemplate: "{{variables.account_id}}",
        },
      ],
    } as const;
    const definitionPath = writeDefinition(definition);
    let createBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/custom-connectors",
        async ({ request }) => {
          createBody = await request.json();
          return HttpResponse.json(
            customConnector({
              id: CONNECTOR_ID,
              fields: [...definition.fields],
              headerInjections: [...definition.headerInjections],
              queryInjections: [...definition.queryInjections],
            }),
            { status: 201 },
          );
        },
      ),
    );

    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "create",
      "--file",
      definitionPath,
    ]);

    expect(createBody).toStrictEqual(definition);
  });

  it("rejects an agent run without custom connector write access", async () => {
    const definitionPath = writeDefinition(manualDefinition());
    const mockConsoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const mockExit = vi.spyOn(process, "exit").mockImplementation(() => {
      return undefined as never;
    });
    vi.stubEnv("OKOU_TOKEN", buildOkouToken(["connector:read"]));

    try {
      await customConnectorCommand.parseAsync([
        "node",
        "okou",
        "create",
        "--file",
        definitionPath,
      ]);

      expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
        "Custom connector creation is not enabled for this agent run",
      );
      expect(mockExit).toHaveBeenCalledWith(1);
    } finally {
      mockConsoleError.mockRestore();
      mockExit.mockRestore();
    }
  });

  it("documents definition-only creation without requesting credentials", () => {
    let createHelp = "";
    createCustomConnectorCommand.configureOutput({
      writeOut: (value) => {
        createHelp += value;
      },
    });
    createCustomConnectorCommand.outputHelp();

    expect(createHelp).toContain("Never include an API token");
    expect(createHelp).toContain("Do not ask the user");
    expect(createHelp).toContain("for the actual API token");
    expect(createHelp).toContain("Declare every credential input");
    expect(createHelp).toContain("{{variables.account_id}}");
    expect(createHelp).toContain("Bearer {{secrets.secret}}");
    expect(createHelp).toContain('"authMode": "oauth"');
    expect(createHelp).toContain("Bearer {{oauth.access_token}}");
    expect(createHelp).toContain("endpoint for MCP");
    expect(createHelp).toContain("Never ask");
    expect(createHelp).toContain("end-user access token or refresh token");
    expect(createHelp).toContain("does not store a");
    expect(createHelp).toContain("start OAuth authorization");

    let customHelp = "";
    customConnectorCommand.configureOutput({
      writeOut: (value) => {
        customHelp += value;
      },
    });
    customConnectorCommand.outputHelp();
    expect(customHelp).toContain("okou connector custom create -h");
    expect(
      customConnectorCommand.commands.map((command) => {
        return command.name();
      }),
    ).toStrictEqual(["create", "update", "show", "delete", "list", "status"]);
  });
});
