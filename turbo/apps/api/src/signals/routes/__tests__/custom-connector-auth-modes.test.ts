import { randomUUID } from "node:crypto";

import {
  customConnectorByIdContract,
  customConnectorsContract,
  type CreateCustomConnectorBody,
  type CustomConnectorAuthMode,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createRouteMocks } from "./helpers/route-test";
import { customConnectorsRoutes } from "../custom-connectors";

const context = testContext();
const mocks = createRouteMocks(context);
const modes = ["none", "manual", "oauth", "automatic"] as const;
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const oauthConfig = Object.freeze({
  providerAdapter: "standard" as const,
  clientId: "mode-lifecycle-client",
  authorizationUrl: "https://oauth.example.test/authorize",
  tokenUrl: "https://oauth.example.test/token",
  tokenEndpointAuthMethod: "client_secret_post" as const,
  pkceMethod: "none" as const,
  scopes: ["read"],
  authorizationParams: {},
});

function definition(
  authMode: CustomConnectorAuthMode,
  endpoint: string,
): CreateCustomConnectorBody {
  return {
    kind: "mcp",
    displayName: "Connector mode lifecycle",
    endpoint,
    transport: "streamable-http",
    authMode,
    fields:
      authMode === "manual"
        ? [{ key: "api_key", label: "API key", kind: "secret", required: true }]
        : [],
    headerInjections:
      authMode === "manual" || authMode === "oauth"
        ? [
            {
              name: "Authorization",
              valueTemplate:
                authMode === "manual"
                  ? "Bearer {{secrets.api_key}}"
                  : "Bearer {{oauth.access_token}}",
            },
          ]
        : [],
    queryInjections: [],
    ...(authMode === "oauth"
      ? { oauthConfig: { ...oauthConfig, clientSecret: "test-client-secret" } }
      : {}),
  };
}

function clients() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;

  function authenticate() {
    mocks.clerk.session(userId, orgId, "org:admin");
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      {
        data: [
          {
            role: "org:admin",
            organization: { id: orgId },
            publicUserData: { userId },
          },
        ],
      },
    );
  }

  authenticate();
  const app = setupApp({
    context,
    routes: customConnectorsRoutes,
  });
  const api = {
    collection: app(customConnectorsContract),
    connector: app(customConnectorByIdContract),
  };
  onTestFinished(async () => {
    authenticate();
    const listed = await accept(api.collection.list({ headers }), [200]);
    for (const connector of listed.body.connectors) {
      await accept(
        api.connector.delete({ headers, params: { id: connector.id } }),
        [204],
      );
    }
  });
  return api;
}

describe("Custom connector authentication modes", () => {
  it.each(modes)(
    "creates and reads a %s connector without changing endpoint queries",
    async (mode) => {
      const api = clients();
      const endpoint = `https://${randomUUID()}.mcp.example.test/server?hl=en&tag=one&tag=two&empty=&encoded=a%20b&literal=a+b&slash=%2f`;
      const created = await accept(
        api.collection.create({ headers, body: definition(mode, endpoint) }),
        [201],
      );
      const read = await accept(
        api.connector.get({ headers, params: { id: created.body.id } }),
        [200],
      );
      expect(read.body).toMatchObject({
        id: created.body.id,
        kind: "mcp",
        endpoint,
        authMode: mode,
      });
      if (mode === "oauth") {
        expect(read.body).toHaveProperty("oauthConfig", oauthConfig);
      } else {
        expect(read.body).not.toHaveProperty("oauthConfig");
      }
      const listed = await accept(api.collection.list({ headers }), [200]);
      expect(listed.body.connectors).toStrictEqual([read.body]);
    },
  );

  it("preserves host-only endpoints and query-only edits", async () => {
    const api = clients();
    const endpoint = "https://mcp-query.example.test?hl=en";
    const created = await accept(
      api.collection.create({ headers, body: definition("none", endpoint) }),
      [201],
    );
    expect(created.body).toMatchObject({ endpoint });
    expect(created.body.slug).toMatch(/^_mcp-query-example-test-[a-f0-9]{6}$/u);

    const updatedEndpoint =
      "https://mcp-query.example.test?hl=de&tag=two&tag=one&empty&encoded=%2F&literal=a+b";
    const updated = await accept(
      api.connector.update({
        headers,
        params: { id: created.body.id },
        body: definition("none", updatedEndpoint),
      }),
      [200],
    );
    expect(updated.body).toMatchObject({
      id: created.body.id,
      slug: created.body.slug,
      endpoint: updatedEndpoint,
    });
    const read = await accept(
      api.connector.get({ headers, params: { id: created.body.id } }),
      [200],
    );
    expect(read.body).toMatchObject({ endpoint: updatedEndpoint });
  });

  it.each([
    "http://mcp.example.test/server?hl=en",
    "https://mcp.example.test:443:444/server?hl=en",
    "https://mcp.example.test:65536/server?hl=en",
    "https://127.0.0.1/server?hl=en",
    "https://[::1]/server?hl=en",
    "https://mcp.example.test/server?hl=en#fragment",
    "https://mcp.example.test/server?hl=en#",
    "https://user:password@mcp.example.test/server?hl=en",
    "https://mcp.example.test/%2e%2e/admin?hl=en",
    "https://{{host}}.example.test/server?hl=en",
  ])("rejects unsafe MCP endpoint %s", async (endpoint) => {
    const api = clients();
    const rejected = await accept(
      api.collection.create({ headers, body: definition("none", endpoint) }),
      [400],
    );
    expect(rejected.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(rejected.body)).not.toContain(endpoint);
    const listed = await accept(api.collection.list({ headers }), [200]);
    expect(listed.body.connectors).toStrictEqual([]);
  });

  it("keeps HTTP firewall prefixes query-free", async () => {
    const api = clients();
    const rejected = await accept(
      api.collection.create({
        headers,
        body: {
          kind: "http",
          displayName: "HTTP query prefix",
          prefixTemplates: ["https://api.example.test/v1/?hl=en"],
          authMode: "none",
          fields: [],
          headerInjections: [],
          queryInjections: [],
        },
      }),
      [400],
    );
    expect(rejected.body).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it.each(modes)(
    "changes OAuth to %s and back through public definition updates",
    async (mode) => {
      const api = clients();
      const endpoint = `https://${randomUUID()}.mcp.example.test/server`;
      const created = await accept(
        api.collection.create({
          headers,
          body: definition("oauth", endpoint),
        }),
        [201],
      );
      for (const destination of [mode, "oauth", "oauth"] as const) {
        const updated = await accept(
          api.connector.update({
            headers,
            params: { id: created.body.id },
            body: definition(destination, endpoint),
          }),
          [200],
        );
        expect(updated.body.authMode).toBe(destination);
        const read = await accept(
          api.connector.get({ headers, params: { id: created.body.id } }),
          [200],
        );
        expect(read.body).toMatchObject({
          id: created.body.id,
          endpoint,
          authMode: destination,
        });
        if (destination === "oauth") {
          expect(read.body).toHaveProperty("oauthConfig", oauthConfig);
        } else {
          expect(read.body).not.toHaveProperty("oauthConfig");
        }
      }
    },
  );

  it("removes an OAuth definition from public reads after deletion", async () => {
    const api = clients();
    const created = await accept(
      api.collection.create({
        headers,
        body: definition(
          "oauth",
          `https://${randomUUID()}.mcp.example.test/server`,
        ),
      }),
      [201],
    );
    await accept(
      api.connector.delete({ headers, params: { id: created.body.id } }),
      [204],
    );
    const removed = await accept(
      api.connector.get({ headers, params: { id: created.body.id } }),
      [404],
    );
    expect(removed.body).toMatchObject({ error: { code: "NOT_FOUND" } });
    const listed = await accept(api.collection.list({ headers }), [200]);
    expect(listed.body.connectors).toStrictEqual([]);
  });
});
