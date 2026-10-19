import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../mocks/server";
import {
  customConnector,
  customMcpConnector,
  stubCustomConnectors,
} from "../../../__tests__/helpers/custom-connectors";
import { customConnectorCommand } from "../index";
import { stubConnectorAccountSummaries } from "../../../__tests__/helpers/connector-accounts";

const connector = customConnector();
const SECRET = "custom-response-secret";

describe("connector custom show/delete", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  beforeEach(() => {
    vi.stubEnv("OKOU_TOKEN", "test-token");
    vi.stubEnv("OKOU_API_BACKEND_URL", "http://localhost:3000");
    for (const command of customConnectorCommand.commands)
      command.setOptionValue("json", undefined);
    server.use(
      stubCustomConnectors([connector]),
      stubConnectorAccountSummaries([]),
    );
  });
  afterEach(() => {
    log.mockClear();
    vi.unstubAllEnvs();
  });

  it("shows only metadata, excluding OAuth app credentials and response extras", async () => {
    server.use(
      http.get(
        `http://localhost:3000/api/custom-connectors/${connector.id}`,
        () => {
          return HttpResponse.json({
            ...connector,
            authMode: "oauth",
            fields: [],
            oauthConfig: {
              providerAdapter: "standard",
              clientId: SECRET,
              hasClientSecret: true,
              authorizationUrl: "https://provider.example/authorize",
              tokenUrl: "https://provider.example/token",
              tokenEndpointAuthMethod: "client_secret_post",
              pkceMethod: "S256",
              scopes: [],
              authorizationParams: {},
              clientSecret: SECRET,
            },
            accessToken: SECRET,
            sessionToken: SECRET,
          });
        },
      ),
    );
    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "show",
      `custom:${connector.id}`,
      "--json",
    ]);
    const output = log.mock.calls.flat().join("\n");
    expect(JSON.parse(output)).toMatchObject({
      id: connector.id,
      authMode: "oauth",
    });
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("oauthConfig");
  });

  it.each([
    customConnector({ permissionBundleRef: "builtin:github@1" }),
    customMcpConnector(),
  ])("shows inspectable nonsecret $kind configuration", async (definition) => {
    server.use(
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
      "show",
      definition.id,
      "--json",
    ]);
    const output = JSON.parse(log.mock.calls.flat().join("\n"));
    expect(output).toMatchObject({
      urlPrefixTemplates: definition.prefixTemplates,
      permissionBundleRef: definition.permissionBundleRef ?? null,
    });
    if (definition.kind === "mcp")
      expect(output).toMatchObject({
        endpoint: definition.endpoint,
        transport: definition.transport,
      });
    expect(output).not.toHaveProperty("headerInjections");
    expect(output).not.toHaveProperty("queryInjections");
  });

  it("deletes the resolved definition without a body or agent grant", async () => {
    let deleted = false;
    server.use(
      http.delete(
        `http://localhost:3000/api/custom-connectors/${connector.id}`,
        async ({ request }) => {
          deleted = true;
          expect(await request.text()).toBe("");
          return new HttpResponse(null, { status: 204 });
        },
      ),
    );
    await customConnectorCommand.parseAsync([
      "node",
      "okou",
      "delete",
      connector.displayName,
      "--json",
    ]);
    expect(deleted).toBe(true);
    expect(JSON.parse(log.mock.calls.flat().join("\n"))).toEqual({
      deletedCustomConnectorId: connector.id,
    });
  });
});
