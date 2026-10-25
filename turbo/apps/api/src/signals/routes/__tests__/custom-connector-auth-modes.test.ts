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
  kind: "http" | "mcp" = "mcp",
): CreateCustomConnectorBody {
  const shared = {
    displayName: "Connector mode lifecycle",
    authMode,
    fields:
      authMode === "manual"
        ? [
            {
              key: "api_key",
              label: "API key",
              kind: "secret" as const,
              required: true,
            },
          ]
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
  return kind === "mcp"
    ? { ...shared, kind, endpoint, transport: "streamable-http" }
    : { ...shared, kind, prefixTemplates: [endpoint] };
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
  it.each([
    ["http", true],
    ["http", false],
    ["mcp", true],
    ["mcp", false],
  ] as const)(
    "rejects declared fields in %s OAuth creation (required: %s)",
    async (kind, required) => {
      const api = clients();
      const rejected = await accept(
        api.collection.create({
          headers,
          body: {
            ...definition("oauth", "https://api.example.test/", kind),
            fields: [
              { key: "region", label: "Region", kind: "variable", required },
            ],
          },
        }),
        [400],
      );
      expect(rejected.body.error.message).toBe(
        "OAuth custom connectors cannot declare fields; remove all fields and their template references",
      );
      const listed = await accept(api.collection.list({ headers }), [200]);
      expect(listed.body.connectors).toStrictEqual([]);
    },
  );

  it.each(["http", "mcp"] as const)(
    "preserves a %s OAuth definition when explicit or inherited mode updates declare fields",
    async (kind) => {
      const api = clients();
      const input = definition("oauth", "https://api.example.test/", kind);
      const created = await accept(
        api.collection.create({ headers, body: input }),
        [201],
      );
      const params = { id: created.body.id };
      for (const authMode of ["oauth", undefined] as const) {
        const rejected = await accept(
          api.connector.update({
            headers,
            params,
            body: {
              ...input,
              displayName: "Rejected update",
              authMode,
              oauthConfig: authMode === "oauth" ? input.oauthConfig : undefined,
              fields: [
                {
                  key: "region",
                  label: "Region",
                  kind: "variable",
                  required: false,
                },
              ],
            },
          }),
          [400],
        );
        expect(rejected.body.error.message).toBe(
          "OAuth custom connectors cannot declare fields; remove all fields and their template references",
        );
        const read = await accept(
          api.connector.get({ headers, params }),
          [200],
        );
        expect(read.body).toStrictEqual(created.body);
      }
      const updated = await accept(
        api.connector.update({
          headers,
          params,
          body: {
            ...input,
            displayName: "Supported OAuth update",
            authMode: undefined,
            oauthConfig: undefined,
          },
        }),
        [200],
      );
      expect(updated.body).toMatchObject({
        id: created.body.id,
        displayName: "Supported OAuth update",
        fields: [],
        storageVersion: created.body.storageVersion,
      });
    },
  );

  it.each(["http", "mcp"] as const)(
    "requires removing member fields when changing a %s definition to OAuth",
    async (kind) => {
      const api = clients();
      const input = {
        ...definition("manual", "https://api.example.test/", kind),
        fields: [
          {
            key: "region",
            label: "Region",
            kind: "variable" as const,
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{variables.region}}",
          },
        ],
      };
      const created = await accept(
        api.collection.create({ headers, body: input }),
        [201],
      );
      const params = { id: created.body.id };
      const oauth = definition("oauth", "https://api.example.test/", kind);
      const rejected = await accept(
        api.connector.update({
          headers,
          params,
          body: { ...oauth, fields: input.fields },
        }),
        [400],
      );
      expect(rejected.body.error.message).toBe(
        "OAuth custom connectors cannot declare fields; remove all fields and their template references",
      );
      const read = await accept(api.connector.get({ headers, params }), [200]);
      expect(read.body).toStrictEqual(created.body);
      const updated = await accept(
        api.connector.update({ headers, params, body: oauth }),
        [200],
      );
      expect(updated.body).toMatchObject({
        id: created.body.id,
        authMode: "oauth",
        fields: [],
        storageVersion: created.body.storageVersion + 1,
      });
    },
  );

  it.each(modes)(
    "creates and reads a %s connector without changing endpoint queries",
    async (mode) => {
      const api = clients();
      const skillMarkdown =
        mode === "oauth" ? "Use the connected account to search." : null;
      if (mode === "oauth") {
        context.mocks.s3.send.mockResolvedValue({});
      }
      const endpoint = `https://${randomUUID()}.mcp.example.test/server?hl=en&tag=one&tag=two&empty=&encoded=a%20b&literal=a+b&slash=%2f`;
      const created = await accept(
        api.collection.create({
          headers,
          body: { ...definition(mode, endpoint), skillMarkdown },
        }),
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
        skillMarkdown,
      });
      if (mode === "oauth") {
        expect(read.body).toHaveProperty("oauthConfig", oauthConfig);
      } else {
        expect(read.body).not.toHaveProperty("oauthConfig");
      }
      const listed = await accept(api.collection.list({ headers }), [200]);
      expect(listed.body.connectors).toStrictEqual([read.body]);

      context.mocks.s3.send.mockResolvedValue({});
      const updatedSkill = "Use the current connector to list project records.";
      const updated = await accept(
        api.connector.update({
          headers,
          params: { id: created.body.id },
          body: { ...definition(mode, endpoint), skillMarkdown: updatedSkill },
        }),
        [200],
      );
      expect(updated.body).toMatchObject({
        id: created.body.id,
        endpoint,
        authMode: mode,
        skillMarkdown: updatedSkill,
        storageVersion: created.body.storageVersion,
      });
      const refreshed = await accept(
        api.connector.get({ headers, params: { id: created.body.id } }),
        [200],
      );
      expect(refreshed.body).toStrictEqual(updated.body);
      if (mode === "oauth") {
        expect(refreshed.body).toHaveProperty("oauthConfig", oauthConfig);
        expect(JSON.stringify(refreshed.body)).not.toContain(
          "test-client-secret",
        );
      } else {
        expect(refreshed.body).not.toHaveProperty("oauthConfig");
      }
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
