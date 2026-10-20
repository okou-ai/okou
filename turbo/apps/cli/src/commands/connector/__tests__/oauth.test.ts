import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../mocks/server";
import {
  authCodeMethod,
  catalogStatusItem,
  stubConnectorCatalogStatus,
} from "../../__tests__/helpers/connector-catalog";
import {
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
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const key of ["add", "reconnect", "accountName", "authMethod", "json"])
      connectorOAuthStartCommand.setOptionValue(key, undefined);
    server.use(stubCustomConnectors([]));
  });
  afterEach(() => {
    log.mockClear();
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

  it.each([undefined, ID])(
    "prints whitelisted custom automatic identity with optional connectionId %s",
    async (connectionId) => {
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
              connector: {
                ...connector,
                connected: true,
                connectedAccountId: ID,
                clientSecret: SECRET,
              },
              connectedAccountId: ID,
              connectionId,
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
        ...(connectionId ? { connectionId } : {}),
      });
    },
  );

  it("preserves the explicit builtin automatic account ID without changing its legacy identity", async () => {
    server.use(
      stubConnectorCatalogStatus([
        catalogStatusItem({
          connectorSlug: "github",
          authMethods: [{ ...authCodeMethod("oauth"), grantKind: "automatic" }],
        }),
      ]),
      http.post(
        "http://localhost:3000/api/connectors/github/automatic/start",
        () => {
          return HttpResponse.json({
            result: "connected",
            connectedAccountId: ID,
            connectionId: ID,
            accessToken: SECRET,
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
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      result: "connected",
      connectedAccountId: ID,
      connectionId: ID,
    });
  });
});
