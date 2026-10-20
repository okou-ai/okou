import { describe, expect, it } from "vitest";

import {
  customConnectorHttpCreateBodySchema,
  customConnectorHttpResponseSchema,
  customConnectorMcpCreateBodySchema,
  customConnectorMcpResponseSchema,
  startCustomConnectorOAuth2ResponseSchema,
} from "../custom-connectors";

const httpNone = {
  displayName: "Public API",
  authMode: "none",
  prefixTemplates: ["https://{{variables.region}}.example.com/"],
  fields: [
    {
      key: "region",
      label: "Region",
      kind: "variable",
      required: true,
    },
  ],
  headerInjections: [],
  queryInjections: [],
} as const;

const mcpNone = {
  kind: "mcp",
  displayName: "Public MCP",
  authMode: "none",
  endpoint: "https://mcp.example.com/server",
  transport: "streamable-http",
  fields: [],
  headerInjections: [],
  queryInjections: [],
} as const;

describe("Custom connector no-auth contracts", () => {
  it("accepts strict HTTP and MCP none definitions", () => {
    expect(customConnectorHttpCreateBodySchema.parse(httpNone)).toStrictEqual(
      httpNone,
    );
    expect(customConnectorMcpCreateBodySchema.parse(mcpNone)).toStrictEqual(
      mcpNone,
    );
  });

  it.each([
    {
      name: "a secret field",
      value: {
        ...httpNone,
        fields: [
          { key: "token", label: "Token", kind: "secret", required: true },
        ],
      },
    },
    {
      name: "a header injection",
      value: {
        ...httpNone,
        headerInjections: [{ name: "Authorization", valueTemplate: "none" }],
      },
    },
  ])("rejects HTTP none with $name", ({ value }) => {
    expect(customConnectorHttpCreateBodySchema.safeParse(value).success).toBe(
      false,
    );
  });

  it("rejects fields on MCP none", () => {
    expect(
      customConnectorMcpCreateBodySchema.safeParse({
        ...mcpNone,
        fields: [
          {
            key: "region",
            label: "Region",
            kind: "variable",
            required: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each(["manual", "oauth"] as const)(
    "keeps empty %s authentication invalid",
    (authMode) => {
      expect(
        customConnectorHttpCreateBodySchema.safeParse({
          ...httpNone,
          authMode,
          ...(authMode === "oauth"
            ? {
                oauthConfig: {
                  providerAdapter: "standard",
                  clientId: "client",
                  clientSecret: "secret",
                  authorizationUrl: "https://example.com/authorize",
                  tokenUrl: "https://example.com/token",
                  tokenEndpointAuthMethod: "client_secret_post",
                  pkceMethod: "none",
                  scopes: [],
                  authorizationParams: {},
                },
              }
            : {}),
        }).success,
      ).toBe(false);
    },
  );

  it("serializes none responses without OAuth state", () => {
    const common = {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "_public-api",
      displayName: "Public API",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "none",
      storageVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    } as const;
    expect(
      customConnectorHttpResponseSchema.parse({
        ...common,
        kind: "http",
        prefixTemplates: ["https://example.com/"],
      }).authMode,
    ).toBe("none");
    expect(
      customConnectorMcpResponseSchema.parse({
        ...common,
        kind: "mcp",
        endpoint: "https://mcp.example.com/server",
        transport: "streamable-http",
        prefixTemplates: [],
        permissionBundleRef: null,
      }).authMode,
    ).toBe("none");
  });
});

describe("Custom connector Automatic auth contracts", () => {
  const automatic = { ...mcpNone, authMode: "automatic" as const };

  it("accepts only credential-free MCP definitions", () => {
    expect(customConnectorMcpCreateBodySchema.parse(automatic)).toStrictEqual(
      automatic,
    );
    expect(
      customConnectorHttpCreateBodySchema.safeParse({
        ...httpNone,
        authMode: "automatic",
      }).success,
    ).toBe(false);
    expect(
      customConnectorMcpCreateBodySchema.safeParse({
        ...automatic,
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{oauth.access_token}}",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("serializes top-level Automatic and both connect outcomes", () => {
    const connector = customConnectorMcpResponseSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      slug: "_public-mcp",
      displayName: "Public MCP",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
      storageVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      kind: "mcp",
      endpoint: "https://mcp.example.com/server",
      transport: "streamable-http",
      prefixTemplates: [],
      permissionBundleRef: null,
      skillMarkdown: null,
    });
    expect(connector.authMode).toBe("automatic");
    expect(
      startCustomConnectorOAuth2ResponseSchema.parse({
        result: "authorization",
        authorizationUrl: "https://issuer.example.com/authorize",
        oauthAttemptId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toMatchObject({ result: "authorization" });
    expect(
      startCustomConnectorOAuth2ResponseSchema.parse({
        result: "connected",
        connector,
        connectionId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toMatchObject({ result: "connected" });
  });
});
