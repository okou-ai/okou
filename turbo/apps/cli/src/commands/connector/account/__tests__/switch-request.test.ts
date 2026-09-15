import type {
  ConnectorAccountInspectionResult,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "../../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  stubAgentCustomConnectors,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { switchConnectorAccountRequestCommand } from "../switch-request";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const CUSTOM_CONNECTOR_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";

function availableInspection(
  target: ConnectorAccountTarget = {
    kind: "builtin",
    connectorSlug: "github",
  },
): ConnectorAccountInspectionResult {
  return {
    kind: "available",
    connectionId: CONNECTION_ID,
    target,
    authMethod: "oauth",
    displayName: "Work",
    externalId: null,
    externalUsername: "octocat",
    externalEmail: "work@example.com",
    connectionStatus: "connected",
    reconnectReason: null,
  };
}

function stubCatalog(): ReturnType<typeof http.get> {
  return stubConnectorCatalogStatus([
    catalogStatusItem({
      connectorSlug: "github",
      label: "GitHub",
      authMethods: [authCodeMethod("oauth")],
    }),
  ]);
}

function stubAgent(): ReturnType<typeof http.get> {
  return http.get(`http://localhost:3000/api/agents/${AGENT_ID}`, () => {
    return HttpResponse.json({
      agentId: AGENT_ID,
      ownerId: "owner-1",
      displayName: "Nova",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "private",
    });
  });
}

function stubAgentBuiltinConnectors(
  enabledConnectorSlugs: readonly string[],
): ReturnType<typeof http.get> {
  return http.get(
    `http://localhost:3000/api/agents/${AGENT_ID}/user-connectors`,
    () => {
      return HttpResponse.json({ enabledConnectorSlugs });
    },
  );
}

function stubInspection(
  result: ConnectorAccountInspectionResult,
  onRequest?: (body: unknown) => void,
): ReturnType<typeof http.post> {
  return http.post(
    "http://localhost:3000/api/connector-accounts/inspect",
    async ({ request }) => {
      const body: unknown = await request.json();
      onRequest?.(body);
      return HttpResponse.json({ results: [result] });
    },
  );
}

function actionUrlFromOutput(output: string): URL {
  const href = output.match(/\[Confirm account switch\]\(([^)]+)\)/)?.[1];
  if (!href) {
    throw new Error("Expected connector account switch action URL");
  }
  return new URL(href);
}

describe("okou connector account switch-request command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_AGENT_ID", AGENT_ID);
    vi.stubEnv("OKOU_CHAT_THREAD_ID", THREAD_ID);
    switchConnectorAccountRequestCommand.setOptionValue(
      "connectionId",
      undefined,
    );
    switchConnectorAccountRequestCommand.setOptionValue(
      "callbackPrompt",
      undefined,
    );
    server.use(
      stubCatalog(),
      stubCustomConnectors([]),
      stubAgent(),
      stubAgentBuiltinConnectors(["github"]),
      stubAgentCustomConnectors([]),
      stubInspection(availableInspection()),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  it("validates and prints an exact built-in account action", async () => {
    let inspectionBody: unknown;
    server.use(
      stubInspection(availableInspection(), (body) => {
        inspectionBody = body;
      }),
    );

    await switchConnectorAccountRequestCommand.parseAsync([
      "node",
      "okou",
      "github",
      "--connection-id",
      CONNECTION_ID,
      "--callback-prompt",
      "Continue with the selected account & finish",
    ]);

    expect(inspectionBody).toStrictEqual({
      selections: [
        {
          connectionId: CONNECTION_ID,
          target: { kind: "builtin", connectorSlug: "github" },
        },
      ],
    });
    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("use Work for GitHub in future runs");
    expect(output).toContain("end the current turn");
    expect(output).toContain("exact callback URL above verbatim");
    expect(output).toContain("omitting any query parameters");
    const url = actionUrlFromOutput(output);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe(
      `/agents/${AGENT_ID}/connector-accounts/${CONNECTION_ID}/select`,
    );
    expect(Array.from(url.searchParams.entries())).toStrictEqual([
      ["kind", "builtin"],
      ["connectorSlug", "github"],
      ["threadId", THREAD_ID],
      ["callbackPrompt", "Continue with the selected account & finish"],
    ]);
  });

  it.each([
    "_acme-search",
    CUSTOM_CONNECTOR_ID,
    `custom:${CUSTOM_CONNECTOR_ID}`,
    "custom:_acme-search",
    "Acme Search",
  ])("resolves and validates custom selector %s", async (selector) => {
    const target = {
      kind: "custom" as const,
      customConnectorId: CUSTOM_CONNECTOR_ID,
    };
    server.use(
      stubCustomConnectors([
        customConnector({
          id: CUSTOM_CONNECTOR_ID,
          slug: "_acme-search",
          displayName: "Acme Search",
        }),
      ]),
      stubAgentCustomConnectors([
        { customConnectorId: CUSTOM_CONNECTOR_ID, permissionNames: [] },
      ]),
      stubInspection(availableInspection(target)),
    );

    await switchConnectorAccountRequestCommand.parseAsync([
      "node",
      "okou",
      selector,
      "--connection-id",
      CONNECTION_ID,
      "--callback-prompt",
      "Continue the search",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(output).toContain("use Work for Acme Search");
    expect(
      Array.from(actionUrlFromOutput(output).searchParams.entries()),
    ).toStrictEqual([
      ["kind", "custom"],
      ["customConnectorId", CUSTOM_CONNECTOR_ID],
      ["threadId", THREAD_ID],
      ["callbackPrompt", "Continue the search"],
    ]);
    expect(output).toContain("exact callback URL above verbatim");
  });

  it("rejects malformed connection IDs before account discovery", async () => {
    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        "invented-account",
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--connection-id must be a valid UUID",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("requires the current web chat agent", async () => {
    vi.stubEnv("OKOU_AGENT_ID", "");

    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Connector account switches require the current web chat agent",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects a hallucinated connector slug", async () => {
    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "invented-connector",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Unknown or unavailable connector: invented-connector",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects missing and wrong-target account references", async () => {
    server.use(
      stubInspection({
        kind: "unavailable",
        connectionId: CONNECTION_ID,
        target: { kind: "builtin", connectorSlug: "github" },
      }),
    );

    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      `Connector account ${CONNECTION_ID} is unavailable for github`,
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects a connector target outside the current agent scope", async () => {
    server.use(stubAgentBuiltinConnectors([]));

    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Connector github is not authorized for the current web chat agent",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects the request when connector accounts are unavailable", async () => {
    server.use(
      http.post("http://localhost:3000/api/connector-accounts/inspect", () => {
        return HttpResponse.json(
          { error: { code: "NOT_FOUND", message: "Not found" } },
          { status: 404 },
        );
      }),
    );

    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "Connector account switching is unavailable",
    );
  });

  it("requires the current web chat callback context", async () => {
    vi.stubEnv("OKOU_CHAT_THREAD_ID", "");

    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "Continue",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--callback-prompt can only target the current web chat thread and agent",
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("rejects an empty callback prompt", async () => {
    await expect(
      switchConnectorAccountRequestCommand.parseAsync([
        "node",
        "okou",
        "github",
        "--connection-id",
        CONNECTION_ID,
        "--callback-prompt",
        "   ",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--callback-prompt cannot be empty",
    );
  });
});
