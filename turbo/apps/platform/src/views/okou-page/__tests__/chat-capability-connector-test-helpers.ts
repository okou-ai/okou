import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import type {
  ConnectorAuthMethodId,
  ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";

import {
  CAPABILITY_AGENT_ID,
  RUN_THREAD_ID,
} from "./chat-capability-test-helpers.ts";

const APP_ORIGIN = "https://app.okou.ai";

export const CONNECTOR_CONNECTION_ID = "e0000000-0000-4000-a000-000000000901";
export const CUSTOM_CONNECTOR_ID = "e0000000-0000-4000-a000-000000000902";

export function browserAuthMethod(
  id: ConnectorAuthMethodId = "oauth",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: "Provider sign-in",
    description: "Sign in with the provider to continue.",
    grantKind: "auth-code",
    manualFields: [],
    startOptions: [],
  };
}

export function noAuthMethod(
  id: ConnectorAuthMethodId = "public",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: "No authorization",
    description: "Enable this connector without an account.",
    grantKind: "none",
    manualFields: [],
    startOptions: [],
  };
}

export function manualAuthMethod(
  id: ConnectorAuthMethodId = "api-key",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: "API key",
    description: "Enter the service credential.",
    grantKind: "manual",
    manualFields: [
      {
        id: "apiKey",
        label: "API key",
        required: true,
        placeholder: "Enter API key",
        inputType: "password",
      },
    ],
    startOptions: [],
  };
}

export function catalogConnector(args: {
  readonly slug: ConnectorSlug;
  readonly label: string;
  readonly method: PublicConnectorCatalogAuthMethodDetail;
  readonly connected?: boolean;
  readonly reconnectRequired?: boolean;
  readonly connectionId?: string;
  readonly tokenExpiresAt?: string | null;
}): PublicConnectorCatalogStatusItem {
  const connected = args.connected ?? false;
  const reconnectRequired = args.reconnectRequired ?? false;
  return {
    slug: args.slug,
    label: args.label,
    description: `${args.label} workspace service`,
    icon: {
      url: `https://icons.example.test/${args.slug}.svg`,
      invertInDarkMode: false,
    },
    category: "Productivity",
    generation: [],
    tags: [],
    authMethods: [args.method],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: connected
      ? {
          id: args.connectionId ?? CONNECTOR_CONNECTION_ID,
          authMethod: args.method.id,
          externalUsername: "workspace-user",
          externalEmail: "workspace@example.test",
          reconnectReason: reconnectRequired
            ? "authorization_expired_or_revoked"
            : null,
        }
      : null,
    connected,
    connectionStatus: connected
      ? reconnectRequired
        ? "reconnect-required"
        : "connected"
      : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: args.tokenExpiresAt ?? null,
    singleAuthCodeAuthMethodId:
      args.method.grantKind === "auth-code" ? args.method.id : null,
    connectNotice: null,
  };
}

export function connectedConnectorResponse(args: {
  readonly slug: ConnectorSlug;
  readonly authMethod: ConnectorAuthMethodId;
  readonly id?: string;
  readonly updatedAt?: string;
  readonly reconnectRequired?: boolean;
}): BuiltinConnectorResponse {
  return {
    id: args.id ?? CONNECTOR_CONNECTION_ID,
    slug: args.slug,
    authMethod: args.authMethod,
    externalId: `${args.slug}-external-account`,
    externalUsername: "workspace-user",
    externalEmail: "workspace@example.test",
    oauthScopes: [],
    connectionStatus: args.reconnectRequired
      ? "reconnect-required"
      : "connected",
    reconnectReason: args.reconnectRequired
      ? "authorization_expired_or_revoked"
      : null,
    tokenExpiresAt: null,
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: args.updatedAt ?? "2026-08-01T09:00:00.000Z",
  };
}

export function customConnector(args: {
  readonly slug: `_${string}`;
  readonly displayName: string;
  readonly connected: boolean;
  readonly permissionBundleRef?: `builtin:${string}@1` | null;
  readonly kind?: "http" | "mcp";
}): CustomConnectorResponse {
  const base = {
    id: CUSTOM_CONNECTOR_ID,
    slug: args.slug,
    displayName: args.displayName,
    fields: [
      {
        key: "apiSecret",
        label: "API secret",
        kind: "secret" as const,
        required: true,
        description: "Secret used to connect this service.",
      },
    ],
    headerInjections: [],
    queryInjections: [],
    authMode: "manual" as const,
    permissionBundleRef: args.permissionBundleRef ?? null,
    skillMarkdown: null,
    storageVersion: 1,
    connected: args.connected,
    ...(args.connected
      ? {
          connectedAccountId: CONNECTOR_CONNECTION_ID,
          connectedAccountUpdatedAt: "2026-08-01T09:00:00.000Z",
        }
      : {}),
    missingRequiredFields: args.connected ? [] : ["apiSecret"],
    configuredFieldKeys: args.connected ? ["apiSecret"] : [],
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
  };
  return args.kind === "http"
    ? {
        ...base,
        kind: "http",
        prefixTemplates: ["https://api.example.test/**"],
      }
    : {
        ...base,
        kind: "mcp",
        endpoint: "https://mcp.example.test",
        transport: "streamable-http",
        prefixTemplates: [],
        permissionBundleRef: null,
      };
}

export function connectorActionUrl(args: {
  readonly slug: string;
  readonly callbackPrompt?: string;
  readonly action?: "authorize" | "connect";
}): string {
  const action =
    args.action ?? (args.slug.startsWith("_") ? "connect" : "authorize");
  const url = new URL(`/connectors/${args.slug}/${action}`, APP_ORIGIN);
  url.searchParams.set("agentId", CAPABILITY_AGENT_ID);
  if (args.callbackPrompt) {
    url.searchParams.set("threadId", RUN_THREAD_ID);
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

export function permissionActionUrl(args: {
  readonly connectorSlug: string;
  readonly permission: string;
  readonly action?: "allow" | "deny";
  readonly expiresIn?: "1h" | "24h" | "7d" | "always";
  readonly callbackPrompt?: string;
}): string {
  const url = new URL(`/agents/${CAPABILITY_AGENT_ID}/permissions`, APP_ORIGIN);
  url.searchParams.set("connectorSlug", args.connectorSlug);
  url.searchParams.set("permission", args.permission);
  url.searchParams.set("action", args.action ?? "allow");
  if (args.expiresIn) {
    url.searchParams.set("expiresIn", args.expiresIn);
  }
  if (args.callbackPrompt) {
    url.searchParams.set("threadId", RUN_THREAD_ID);
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

export function bankingActionUrl(args: {
  readonly reason: string;
  readonly callbackPrompt: string;
}): string {
  const url = new URL(`/agents/${CAPABILITY_AGENT_ID}/banking`, APP_ORIGIN);
  url.searchParams.set("reason", args.reason);
  url.searchParams.set("threadId", RUN_THREAD_ID);
  url.searchParams.set("callbackPrompt", args.callbackPrompt);
  return url.href;
}

export function permissionMetadata(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly permissions: readonly string[];
}): PublicConnectorCatalogPermissionDetail {
  return {
    connectorSlug: args.connectorSlug,
    label: args.label,
    icon: {
      url: `https://icons.example.test/${args.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: args.permissions.length,
    permissions: args.permissions.map((name) => {
      return { name, description: `Use ${name}.` };
    }),
    categories: null,
    defaultPolicy: {
      permissionDefault: "ask",
      unknownPolicy: "ask",
    },
  };
}
