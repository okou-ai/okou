import { randomUUID } from "node:crypto";
import { connectorCatalogArtifactSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE } from "@okouai/connectors/connector-catalog/artifacts/mcp-auth";

import { env, mockEnv } from "../../../../lib/env";
import {
  API_TEST_CONNECTOR_CATALOG,
  installApiTestConnectorCatalog,
} from "../../../../test-fixtures/connector-catalog";

export async function installAutomaticMcpCatalog(
  args: {
    readonly slug?: string;
    readonly methodId?: string;
    readonly storageVersion?: number;
    readonly endpoint?: string;
    readonly isolateSource?: boolean;
    readonly additionalAutomaticMethodId?: string;
    readonly additionalNoAuthMethodId?: string;
    readonly firewallAuth?: "none" | "oauth";
  } = {},
) {
  const slug = args.slug ?? `builtin-${randomUUID().slice(0, 8)}`;
  const methodId = args.methodId ?? "smart-connect";
  const endpoint = args.endpoint ?? "https://automatic-mcp.example.test/server";
  const outputs = {
    accessToken: "$secrets.AUTOMATIC_ACCESS_TOKEN",
    refreshToken: "$secrets.AUTOMATIC_REFRESH_TOKEN",
  };
  const template = API_TEST_CONNECTOR_CATALOG.connectors.find((connector) => {
    return connector.slug === "public-mcp";
  });
  if (!template) {
    throw new Error("Expected builtin MCP fixture connector");
  }
  if (args.isolateSource !== false) {
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", `automatic-${randomUUID()}`);
  }
  const method = {
    id: methodId,
    label: "Connect",
    description: null,
    visible: true,
    storage: {
      version: args.storageVersion ?? 1,
      secrets: ["AUTOMATIC_ACCESS_TOKEN", "AUTOMATIC_REFRESH_TOKEN"],
      variables: [],
    },
    grant: { kind: "automatic", callbackOrigin: "api", outputs },
    access: { kind: "automatic", inputs: outputs, outputs },
    revoke: { kind: "none" },
  };
  const firewallAuthHeaders: Record<string, string> =
    args.firewallAuth === "none"
      ? {}
      : { Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE };
  const catalog = connectorCatalogArtifactSchema.parse({
    ...API_TEST_CONNECTOR_CATALOG,
    catalogVersion: `automatic-${randomUUID()}`,
    connectors: [
      ...API_TEST_CONNECTOR_CATALOG.connectors.filter((connector) => {
        return connector.slug !== slug;
      }),
      {
        ...template,
        slug,
        label: "Automatic Tools",
        mcp: { transport: "streamable-http", endpoint },
        authMethods: [
          method,
          ...(args.additionalAutomaticMethodId
            ? [{ ...method, id: args.additionalAutomaticMethodId }]
            : []),
          ...(args.additionalNoAuthMethodId
            ? [
                {
                  id: args.additionalNoAuthMethodId,
                  label: "No authentication",
                  description: null,
                  visible: true,
                  storage: { version: 1, secrets: [], variables: [] },
                  grant: { kind: "none" },
                  access: { kind: "none" },
                  revoke: { kind: "none" },
                },
              ]
            : []),
        ],
        firewall: {
          kind: "generated",
          billable: false,
          config: {
            description: "Automatic Tools",
            apis: [
              {
                base: endpoint,
                auth:
                  args.firewallAuth === "none"
                    ? {}
                    : { headers: firewallAuthHeaders },
                permissions: [],
              },
            ],
          },
          categories: null,
          defaultAllowed: null,
          defaultUnknownPolicy: "allow",
        },
      },
    ],
  });
  await installApiTestConnectorCatalog({ catalog });
  return {
    bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    slug,
    methodId,
    endpoint,
    firewallAuthHeaders,
    target: { kind: "builtin" as const, connectorSlug: slug },
  };
}
