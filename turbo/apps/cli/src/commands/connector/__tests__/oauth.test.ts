import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
  customConnector,
  customMcpConnector,
  stubCustomConnectors,
} from "../../__tests__/helpers/custom-connectors";
import { connectorOAuthCommand, connectorOAuthStartCommand } from "../oauth";

const ID = "11111111-1111-4111-8111-111111111111";
const SECRET = "oauth-secret-must-not-appear";
const URL =
  "https://provider.example/authorize?state=opaque&scope=read%20write";

describe("connector oauth start", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const key of ["add", "reconnect", "accountName", "authMethod", "json"])
      connectorOAuthStartCommand.setOptionValue(key, undefined);
    server.use(stubCustomConnectors([]));
  });
  afterEach(() => {
    log.mockClear();
    error.mockClear();
    exit.mockClear();
    vi.unstubAllEnvs();
  });

  it.each([
    ["auth-code", "oauth"],
    ["openid-auth", "openid"],
    ["automatic", "automatic"],
  ] as const)(
    "starts %s using only the member account intent",
    async (grantKind, path) => {
      server.use(
        stubConnectorCatalogStatus([
          catalogStatusItem({
            connectorSlug: "github",
            authMethods: [{ ...authCodeMethod("oauth"), grantKind }],
          }),
        ]),
        http.post(
          `http://localhost:3000/api/connectors/github/${path}/start`,
          async ({ request }) => {
            expect(await request.json()).toEqual({
              authMethod: "oauth",
              account: { intent: "reconnect", connectionId: ID },
            });
            return HttpResponse.json({
              ...(grantKind === "automatic" ? { result: "authorization" } : {}),
              authorizationUrl: URL,
              oauthAttemptId: ID,
              accessToken: SECRET,
              token: SECRET,
              sessionToken: SECRET,
              clientSecret: SECRET,
            });
          },
        ),
      );
      await connectorOAuthCommand.parseAsync([
        "node",
        "okou",
        "start",
        "github",
        "--reconnect",
        ID,
        "--json",
      ]);
      const output = log.mock.calls.flat().join("\n");
      expect(JSON.parse(output)).toEqual({
        result: "authorization",
        authorizationUrl: URL,
        oauthAttemptId: ID,
      });
      expect(output).not.toContain(SECRET);
    },
  );

  it("starts custom automatic authentication and prints only the account ID when already connected", async () => {
    const connector = customMcpConnector({
      authMode: "automatic",
      fields: [],
      headerInjections: [],
      queryInjections: [],
    });
    server.use(
      stubConnectorCatalogStatus([]),
      stubCustomConnectors([connector]),
      http.post(
        `http://localhost:3000/api/custom-connectors/${connector.id}/oauth2/start`,
        async ({ request }) => {
          expect(await request.json()).toEqual({
            account: { intent: "add", displayName: "Work" },
          });
          return HttpResponse.json({
            result: "connected",
            connector: { ...customConnector(), clientSecret: SECRET },
            connectedAccountId: ID,
            password: SECRET,
          });
        },
      ),
    );
    await connectorOAuthCommand.parseAsync([
      "node",
      "okou",
      "start",
      `custom:${connector.id}`,
      "--add",
      "--account-name",
      "Work",
      "--json",
    ]);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      result: "connected",
      connectedAccountId: ID,
    });
  });

  it.each(["builtin", "custom"])(
    "rejects an automatic reconnect response for another %s account",
    async (kind) => {
      const connector = customMcpConnector({
        authMode: "automatic",
        fields: [],
        headerInjections: [],
        queryInjections: [],
      });
      server.use(
        stubConnectorCatalogStatus(
          kind === "builtin"
            ? [
                catalogStatusItem({
                  connectorSlug: "github",
                  authMethods: [
                    { ...authCodeMethod("oauth"), grantKind: "automatic" },
                  ],
                }),
              ]
            : [],
        ),
        stubCustomConnectors(kind === "custom" ? [connector] : []),
        http.post(
          kind === "builtin"
            ? "http://localhost:3000/api/connectors/github/automatic/start"
            : `http://localhost:3000/api/custom-connectors/${connector.id}/oauth2/start`,
          () => {
            return HttpResponse.json({
              result: "connected",
              connectedAccountId: "22222222-2222-4222-8222-222222222222",
              accessToken: SECRET,
            });
          },
        ),
      );
      await expect(
        connectorOAuthCommand.parseAsync([
          "node",
          "okou",
          "start",
          kind === "builtin" ? "github" : `custom:${connector.id}`,
          "--reconnect",
          ID,
          "--json",
        ]),
      ).rejects.toThrow("process.exit called");
      expect(log).not.toHaveBeenCalled();
      expect(error.mock.calls.flat().join("\n")).toContain(
        "account identity mismatch",
      );
      expect(error.mock.calls.flat().join("\n")).not.toContain(SECRET);
    },
  );

  it("rejects a supplied authorization connection ID that differs from the reconnect target", async () => {
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "github",
          authMethods: [authCodeMethod("oauth")],
        }),
      ]),
      http.post(
        "http://localhost:3000/api/connectors/github/oauth/start",
        () => {
          return HttpResponse.json({
            authorizationUrl: URL,
            oauthAttemptId: ID,
            connectionId: "22222222-2222-4222-8222-222222222222",
          });
        },
      ),
    );
    await expect(
      connectorOAuthCommand.parseAsync([
        "node",
        "okou",
        "start",
        "github",
        "--reconnect",
        ID,
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).toContain(
      "account identity mismatch",
    );
  });

  it("does not print authorization URLs carrying raw token material", async () => {
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "github",
          authMethods: [authCodeMethod("oauth")],
        }),
      ]),
      http.post(
        "http://localhost:3000/api/connectors/github/oauth/start",
        () => {
          return HttpResponse.json({
            authorizationUrl: `https://provider.example/authorize?sessionToken=${SECRET}`,
            oauthAttemptId: ID,
          });
        },
      ),
    );
    await expect(
      connectorOAuthCommand.parseAsync([
        "node",
        "okou",
        "start",
        "github",
        "--add",
        "--json",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join("\n")).not.toContain(SECRET);
  });

  it("suppresses reflected OAuth server errors", async () => {
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "github",
          authMethods: [authCodeMethod("oauth")],
        }),
      ]),
      http.post(
        "http://localhost:3000/api/connectors/github/oauth/start",
        () => {
          return HttpResponse.json(
            { error: { message: SECRET, code: SECRET } },
            { status: 403 },
          );
        },
      ),
    );
    await expect(
      connectorOAuthCommand.parseAsync([
        "node",
        "okou",
        "start",
        "github",
        "--add",
      ]),
    ).rejects.toThrow("process.exit called");
    expect(error.mock.calls.flat().join("\n")).not.toContain(SECRET);
  });
});
