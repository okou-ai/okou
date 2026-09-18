import { http, HttpResponse } from "msw";
import type {
  CustomConnectorHttpResponse,
  CustomConnectorMcpResponse,
  CustomConnectorResponse,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  customConnectorHttpResponseSchema,
  customConnectorMcpResponseSchema,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type { McpConnector } from "@okouai/api-contracts/contracts/mcp-connectors";
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";

export function customConnector(
  overrides: Partial<CustomConnectorHttpResponse> = {},
): CustomConnectorHttpResponse {
  return customConnectorHttpResponseSchema.parse({
    kind: "http",
    id: "33333333-3333-4333-8333-333333333333",
    slug: "_acme-search",
    displayName: "Acme Search",
    prefixTemplates: ["https://api.acme.test/v1/"],
    fields: [
      {
        key: "apiKey",
        label: "API key",
        kind: "secret",
        required: true,
      },
    ],
    headerInjections: [
      {
        name: "Authorization",
        valueTemplate: "Bearer {{secrets.apiKey}}",
      },
    ],
    queryInjections: [],
    authMode: "manual",
    storageVersion: 1,
    connected: false,
    missingRequiredFields: ["apiKey"],
    configuredFieldKeys: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

export function customMcpConnector(
  overrides: Partial<CustomConnectorMcpResponse> = {},
): CustomConnectorMcpResponse {
  return customConnectorMcpResponseSchema.parse({
    ...customConnector(),
    kind: "mcp",
    id: "44444444-4444-4444-8444-444444444444",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    endpoint: "https://mcp.acme.test/server",
    transport: "streamable-http",
    prefixTemplates: [],
    ...overrides,
  });
}

export function stubCustomConnectors(
  connectors: readonly CustomConnectorResponse[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/custom-connectors`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function runMcpConnector(
  overrides: Partial<McpConnector> = {},
): McpConnector {
  return {
    target: {
      kind: "custom",
      customConnectorId: "44444444-4444-4444-8444-444444444444",
    },
    connectionId: "77777777-7777-4777-8777-777777777777",
    slug: "_acme-mcp",
    displayName: "Acme MCP",
    transport: "streamable-http",
    endpoint: "https://mcp.example.test/server",
    connected: true,
    ...overrides,
  };
}

export function stubRunMcpConnectors(
  connectors: readonly McpConnector[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/mcp-connectors`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubAgentCustomConnectors(
  grants: readonly AgentCustomConnectorGrant[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/agents/:id/custom-connectors`, () => {
    return HttpResponse.json({ grants });
  });
}
