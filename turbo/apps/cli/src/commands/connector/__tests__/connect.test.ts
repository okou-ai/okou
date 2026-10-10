/**
 * Tests for okou connector connect command
 *
 * Tests command-level behavior via parseAsync():
 * - Entry point: command.parseAsync()
 * - Mock external API with MSW
 * - Exercise real parsing, API client, and output formatting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { http, HttpResponse } from "msw";
import chalk from "chalk";

import { server } from "../../../mocks/server";
import { connectCommand } from "../connect";
import {
  customConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import {
  catalogStatusItem,
  manualAuthMethod,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";

const DEFAULT_CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const SIBLING_CONNECTION_ID = "22222222-2222-4222-8222-222222222222";

function connectorResponse(
  connectorSlug: string,
  authMethod = "api-token",
  id = "00000000-0000-4000-8000-000000000001",
) {
  return {
    id,
    slug: connectorSlug,
    authMethod,
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("okou connector connect command", () => {
  const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  const mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  const mockConsoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => {});

  beforeEach(() => {
    chalk.level = 0;
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    vi.stubEnv("OKOU_TOKEN", "test-token");
    connectCommand.setOptionValue("accountName", undefined);
    connectCommand.setOptionValue("add", undefined);
    connectCommand.setOptionValue("authMethod", undefined);
    connectCommand.setOptionValue("json", undefined);
    connectCommand.setOptionValue("reconnect", undefined);
    connectCommand.setOptionValue("value", []);
  });

  afterEach(() => {
    mockExit.mockClear();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([
    "test-subdomain",
    "Test Subdomain",
    "builtin:test-subdomain",
    "builtin:Test Subdomain",
  ])(
    "connects builtin selector %s and sends explicit add",
    async (selector) => {
      let receivedBody: unknown;
      server.use(
        http.get("http://localhost:3000/api/connectors/:connectorSlug", () => {
          return HttpResponse.json(
            {
              error: { message: "Connector not found", code: "NOT_FOUND" },
            },
            { status: 404 },
          );
        }),
        http.post(
          "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
          async ({ params, request }) => {
            expect(params.connectorSlug).toBe("test-subdomain");
            receivedBody = await request.json();
            return HttpResponse.json(
              connectorResponse(String(params.connectorSlug)),
            );
          },
        ),
      );

      await connectCommand.parseAsync([
        "node",
        "cli",
        selector,
        "--value",
        "apiToken=secret-token",
        "--value",
        "subdomain=example",
        "--value",
        "email=support@example.com",
      ]);

      expect(receivedBody).toStrictEqual({
        account: { intent: "add" },
        authMethod: "api-token",
        values: {
          apiToken: "secret-token",
          subdomain: "example",
          email: "support@example.com",
        },
      });
      const output = mockConsoleLog.mock.calls.flat().join("\n");
      expect(output).toContain("Test Subdomain connected");
      expect(output).toContain("okou connector status test-subdomain");
      expect(output).not.toContain("secret-token");
    },
  );

  it("rejects a custom slug from the builtin manual-connect flow", async () => {
    const connector = customConnector();
    server.use(stubCustomConnectors([connector]));

    await expect(
      connectCommand.parseAsync([
        "node",
        "okou",
        connector.slug,
        "--add",
        "--value",
        "apiKey=test-custom-key",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      `Unknown or unavailable connector: ${connector.slug}`,
    );
    expect(mockConsoleLog).not.toHaveBeenCalled();
  });

  it("preserves reconnect syntax and resolves the current default exactly", async () => {
    let receivedBody: unknown;
    server.use(
      http.get(
        "http://localhost:3000/api/connectors/:connectorSlug",
        ({ params }) => {
          return HttpResponse.json(
            connectorResponse(
              String(params.connectorSlug),
              "api-token",
              DEFAULT_CONNECTION_ID,
            ),
          );
        },
      ),
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        async ({ params, request }) => {
          receivedBody = await request.json();
          return HttpResponse.json(
            connectorResponse(
              String(params.connectorSlug),
              "api-token",
              DEFAULT_CONNECTION_ID,
            ),
          );
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "openai",
      "--value",
      "apiKey=sk-updated",
    ]);

    expect(receivedBody).toStrictEqual({
      account: {
        intent: "reconnect",
        connectionId: DEFAULT_CONNECTION_ID,
      },
      authMethod: "api-token",
      values: { apiKey: "sk-updated" },
    });
  });

  it("reconnects one explicitly selected sibling without resolving the default", async () => {
    let defaultReadCount = 0;
    let receivedBody: unknown;
    server.use(
      http.get("http://localhost:3000/api/connectors/:connectorSlug", () => {
        defaultReadCount += 1;
        return HttpResponse.json(connectorResponse("openai"));
      }),
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        async ({ request }) => {
          receivedBody = await request.json();
          return HttpResponse.json(
            connectorResponse("openai", "api-token", SIBLING_CONNECTION_ID),
          );
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "openai",
      "--reconnect",
      SIBLING_CONNECTION_ID,
      "--value",
      "apiKey=sk-sibling",
    ]);

    expect(defaultReadCount).toBe(0);
    expect(receivedBody).toStrictEqual({
      account: {
        intent: "reconnect",
        connectionId: SIBLING_CONNECTION_ID,
      },
      authMethod: "api-token",
      values: { apiKey: "sk-sibling" },
    });
  });

  it("connects with an explicit manual grant auth method", async () => {
    let receivedBody: unknown;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        async ({ params, request }) => {
          receivedBody = await request.json();
          return HttpResponse.json(
            connectorResponse(String(params.connectorSlug)),
          );
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "openai",
      "--add",
      "--account-name",
      " Work ",
      "--auth-method",
      "api-token",
      "--value",
      "apiKey=sk-test",
    ]);

    expect(receivedBody).toStrictEqual({
      account: { intent: "add", displayName: "Work" },
      authMethod: "api-token",
      values: {
        apiKey: "sk-test",
      },
    });
  });

  it("uses server-authored connector and auth method identities", async () => {
    const connectorSlug = "server-authored-connector";
    const authMethod = "partner-token";
    let receivedType: string | undefined;
    let receivedBody: unknown;
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug,
          label: "Partner Connector",
          authMethods: [manualAuthMethod(authMethod)],
        }),
      ]),
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        async ({ params, request }) => {
          receivedType = String(params.connectorSlug);
          receivedBody = await request.json();
          return HttpResponse.json(
            connectorResponse(connectorSlug, authMethod),
          );
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      connectorSlug,
      "--add",
      "--value",
      "apiKey=secret-token",
    ]);

    expect(receivedType).toBe(connectorSlug);
    expect(receivedBody).toStrictEqual({
      account: { intent: "add" },
      authMethod,
      values: { apiKey: "secret-token" },
    });
  });

  it("prints JSON output when requested", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        ({ params }) => {
          return HttpResponse.json(
            connectorResponse(String(params.connectorSlug)),
          );
        },
      ),
    );

    await connectCommand.parseAsync([
      "node",
      "cli",
      "openai",
      "--add",
      "--value",
      "apiKey=sk-test",
      "--json",
    ]);

    const output = mockConsoleLog.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toMatchObject({
      slug: "openai",
      authMethod: "api-token",
    });
  });

  it("fails with usage guidance when no values are provided", async () => {
    await expect(
      connectCommand.parseAsync(["node", "cli", "openai", "--add"]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "At least one --value NAME=VALUE is required",
    );
    expect(errorOutput).toContain(
      "okou connector connect openai --value apiKey=token",
    );
  });

  it("fails before the request for malformed values", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--add",
        "--value",
        "apiKey",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Invalid --value format");
    expect(errorOutput).toContain("Use --value NAME=VALUE");
  });

  it("rejects account names without an explicit add", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--account-name",
        "Work",
        "--value",
        "apiKey=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    expect(mockConsoleError.mock.calls.flat().join("\n")).toContain(
      "--account-name requires --add",
    );
  });

  it("rejects invalid account names before requests", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--add",
        "--account-name",
        "",
        "--value",
        "apiKey=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
  });

  it("rejects conflicting add and reconnect choices", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--add",
        "--reconnect",
        DEFAULT_CONNECTION_ID,
        "--value",
        "apiKey=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
  });

  it("rejects malformed reconnect IDs before requests", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("openai"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--reconnect",
        "not-a-uuid",
        "--value",
        "apiKey=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
  });

  it("fails before the request when the selected auth method is not configured", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("github"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "github",
        "--add",
        "--auth-method",
        "api-token",
        "--value",
        "apiToken=ghp-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "github connector does not have api-token auth method",
    );
    expect(errorOutput).not.toContain("ghp-test");
  });

  it("fails before the request when the selected auth method is not a manual grant", async () => {
    let requestCalled = false;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCalled = true;
          return HttpResponse.json(connectorResponse("stripe"));
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "stripe",
        "--add",
        "--auth-method",
        "oauth",
        "--value",
        "apiKey=sk-test",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCalled).toBeFalsy();
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "stripe oauth auth method does not use a manual grant",
    );
    expect(errorOutput).not.toContain("sk-test");
  });

  it("surfaces API validation errors without printing secret values", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          return HttpResponse.json(
            {
              error: {
                message: "Missing required manual grant field(s): email",
                code: "BAD_REQUEST",
              },
            },
            { status: 400 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "test-subdomain",
        "--add",
        "--value",
        "apiToken=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Missing required manual grant field");
    expect(errorOutput).not.toContain("secret-token");
  });

  it("surfaces unavailable connector errors without printing secret values", async () => {
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          return HttpResponse.json(
            {
              error: {
                message: "Connector is not available",
                code: "FORBIDDEN",
              },
            },
            { status: 403 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "test-subdomain",
        "--add",
        "--value",
        "apiToken=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("Connector is not available");
    expect(errorOutput).not.toContain("secret-token");
  });

  it("surfaces ambiguous account conflicts without retrying or printing secret values", async () => {
    let requestCount = 0;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCount += 1;
          return HttpResponse.json(
            {
              error: {
                message: "Multiple connector accounts require an exact choice",
                code: "CONFLICT",
              },
            },
            { status: 409 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "test-subdomain",
        "--add",
        "--value",
        "apiToken=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCount).toBe(1);
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain(
      "409: Multiple connector accounts require an exact choice",
    );
    expect(errorOutput).not.toContain("secret-token");
  });

  it("surfaces missing exact reconnects without retrying or printing secrets", async () => {
    let requestCount = 0;
    server.use(
      http.post(
        "http://localhost:3000/api/connectors/:connectorSlug/manual-grant",
        () => {
          requestCount += 1;
          return HttpResponse.json(
            {
              error: {
                message: "Connector account not found",
                code: "NOT_FOUND",
              },
            },
            { status: 404 },
          );
        },
      ),
    );

    await expect(
      connectCommand.parseAsync([
        "node",
        "cli",
        "openai",
        "--reconnect",
        SIBLING_CONNECTION_ID,
        "--value",
        "apiKey=secret-token",
      ]),
    ).rejects.toThrow("process.exit called");

    expect(requestCount).toBe(1);
    const errorOutput = mockConsoleError.mock.calls.flat().join("\n");
    expect(errorOutput).toContain("404: Connector account not found");
    expect(errorOutput).not.toContain("secret-token");
  });
});
