import { createHash } from "node:crypto";
import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogAuthMethod,
} from "../connector-catalog/artifacts/artifacts";
import {
  decodeConnectorCatalogSnapshot,
  encodeConnectorCatalogSnapshot,
} from "../connector-catalog/artifacts/loader";
import { validateConnectorCatalogArtifact } from "../connector-catalog/artifacts/relationships";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../connector-catalog/compatibility";

const endpoint = "https://tools.example.com/mcp";

function method(
  kind: "none" | "manual" | "automatic",
): ConnectorCatalogAuthMethod {
  const common = {
    id: kind,
    label: "Connect",
    description: null,
    visible: true,
    revoke: { kind: "none" as const },
  };
  if (kind === "none") {
    return {
      ...common,
      storage: { version: 1, secrets: [], variables: [] },
      grant: { kind },
      access: { kind: "static", envBindings: {} },
    };
  }
  if (kind === "manual") {
    return {
      ...common,
      storage: { version: 1, secrets: ["MCP_CREDENTIAL"], variables: [] },
      grant: {
        kind,
        fields: [
          {
            privateName: "MCP_CREDENTIAL",
            publicId: "token",
            label: "Token",
            placeholder: null,
            storage: "secret",
            required: true,
          },
        ],
      },
      access: {
        kind: "static",
        envBindings: { MCP_TOKEN: "$secrets.MCP_CREDENTIAL" },
      },
    };
  }
  const tokens = {
    access_token: "$secrets.MCP_ACCESS",
    refresh_token: "$secrets.MCP_REFRESH",
  };
  return {
    ...common,
    storage: {
      version: 1,
      secrets: ["MCP_ACCESS", "MCP_REFRESH"],
      variables: [],
    },
    grant: { kind, callbackOrigin: "api", outputs: tokens },
    access: { kind, inputs: tokens },
  };
}

function artifact(
  kind: "none" | "manual" | "automatic" = "none",
  injection: "headers" | "query" = "headers",
): ConnectorCatalogArtifact {
  return {
    artifactSchemaVersion: 3,
    catalogVersion: "test-mcp-v1",
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      {
        slug: "tools",
        label: "Tools",
        description: "Test tools",
        category: "testing",
        generation: [],
        tags: [],
        mcp: { transport: "streamable-http", endpoint },
        authMethods: [method(kind)],
        icon: { key: "tools.svg", invertInDarkMode: false },
        skill: { kind: "none" },
        firewall: {
          kind: "generated",
          billable: false,
          categories: null,
          defaultAllowed: null,
          defaultUnknownPolicy: "allow",
          config: {
            apis: [
              {
                base: endpoint,
                hostPolicy: { kind: "publicDestination" },
                permissions: [],
                auth:
                  kind !== "manual"
                    ? {}
                    : injection === "headers"
                      ? {
                          headers: {
                            Authorization: "Bearer ${{ secrets.MCP_TOKEN }}",
                          },
                        }
                      : { query: { api_key: "${{ secrets.MCP_TOKEN }}" } },
              },
            ],
          },
        },
      },
    ],
  };
}

function decode(input: ConnectorCatalogArtifact): ConnectorCatalogArtifact {
  const bytes = Buffer.from(JSON.stringify(input));
  return decodeConnectorCatalogSnapshot({
    catalogGzip: encodeConnectorCatalogSnapshot(bytes),
    catalogRawSize: bytes.length,
    catalogVersion: input.catalogVersion,
    catalogDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  }).artifact;
}

describe("builtin MCP catalog", () => {
  it.each(["none", "manual", "automatic"] as const)(
    "validates and roundtrips %s without inventing a provider",
    (kind) => {
      const input = artifact(kind);
      expect(decode(input)).toStrictEqual(input);
      const filtered = evaluateConnectorCatalogCompatibility({
        artifact: input,
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return false;
          },
        }),
      });
      expect(filtered).toStrictEqual(
        kind === "automatic"
          ? [
              {
                connectorSlug: "tools",
                authMethodId: "automatic",
                reasons: ["unsupported-generic-strategy"],
              },
            ]
          : [],
      );
    },
  );

  it("accepts manual query auth using the same account storage", () => {
    expect(decode(artifact("manual", "query"))).toStrictEqual(
      artifact("manual", "query"),
    );
  });

  it.each([
    "http://tools.example.com/mcp",
    "https://127.0.0.1/mcp",
    "https://10.0.0.1/mcp",
    "https://[::1]/mcp",
    "https://user:pass@tools.example.com/mcp",
    "https://tools.example.com/mcp?token=x",
    "https://tools.example.com/mcp#fragment",
    "https://{host}/mcp",
    "https://tools.example.com/a/../mcp",
  ])("rejects unsafe or noncanonical endpoint %s", (invalid) => {
    const input = artifact();
    input.connectors[0]!.mcp!.endpoint = invalid;
    expect(connectorCatalogArtifactSchema.safeParse(input).success).toBe(false);
  });

  it("keeps MCP optional and old HTTP artifact content unchanged", () => {
    const input = artifact("manual");
    delete input.connectors[0]!.mcp;
    expect(decode(input)).toStrictEqual(input);
    expect(Object.hasOwn(decode(input).connectors[0]!, "mcp")).toBe(false);
  });

  it.each([
    "endpoint",
    "permissions",
    "none-injection",
    "none-storage",
    "automatic-bindings",
    "automatic-client",
  ])("rejects invalid %s relationships", (invalid) => {
    const input = artifact(
      invalid.startsWith("automatic") ? "automatic" : "none",
    );
    const connector = input.connectors[0]!;
    const authMethod = connector.authMethods[0]!;
    if (connector.firewall.kind !== "generated") {
      throw new Error("Expected generated fixture firewall");
    }
    const api = connector.firewall.config.apis[0]!;
    if (invalid === "endpoint") {
      api.base = "https://tools.example.com";
    }
    if (invalid === "permissions") {
      api.permissions = [{ name: "read", rules: ["GET /"] }];
    }
    if (invalid === "none-injection") {
      api.auth = { headers: { Authorization: "Bearer fixed-value" } };
    }
    if (invalid === "none-storage") {
      authMethod.storage.secrets.push("UNEXPECTED_SECRET");
    }
    if (
      invalid === "automatic-bindings" &&
      authMethod.access.kind === "automatic"
    ) {
      authMethod.access.inputs.refresh_token = "$secrets.MCP_ACCESS";
    }
    if (invalid === "automatic-client") {
      authMethod.client = {
        clientRegistration: "dynamic",
        clientType: "public",
      };
    }
    expect(() => {
      return validateConnectorCatalogArtifact(input);
    }).toThrow();
  });
});
