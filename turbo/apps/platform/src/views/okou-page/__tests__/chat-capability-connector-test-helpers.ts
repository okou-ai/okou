import { catalogFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
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

import { RUN_THREAD_ID } from "./chat-capability-test-helpers.ts";

const APP_ORIGIN = "https://app.okou.ai";

export const CONNECTOR_CONNECTION_ID = "e0000000-0000-4000-a000-000000000901";

export function browserAuthMethod(
  id: ConnectorAuthMethodId = "oauth",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: "Provider sign-in",
    description: "Sign in with the provider to continue.",
    grantKind: "auth-code",
    supportsRefresh: true,
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
    supportsRefresh: false,
    manualFields: [],
    startOptions: [],
  };
}

export function catalogConnector(args: {
  readonly slug: ConnectorSlug;
  readonly label: string;
  readonly method: PublicConnectorCatalogAuthMethodDetail;
  readonly hasAccount?: boolean;
  readonly reconnectRequired?: boolean;
  readonly connectionId?: string;
  readonly tokenExpiresAt?: string | null;
}): PublicConnectorCatalogStatusItem {
  const hasAccount = args.hasAccount ?? false;
  const reconnectRequired = args.reconnectRequired ?? false;
  return catalogFixture({
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
    singleAuthCodeAuthMethodId:
      args.method.grantKind === "auth-code" ? args.method.id : null,
    connectNotice: null,
    account: hasAccount
      ? {
          id: args.connectionId ?? CONNECTOR_CONNECTION_ID,
          authMethod: args.method.id,
          externalUsername: "workspace-user",
          externalEmail: "workspace@example.test",
          reconnectReason: reconnectRequired
            ? "authorization_expired_or_revoked"
            : null,
          connectionStatus: reconnectRequired
            ? "reconnect-required"
            : "connected",
          tokenExpiresAt: args.tokenExpiresAt ?? null,
        }
      : undefined,
  });
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

export function connectorActionUrl(args: {
  readonly slug: string;
  readonly callbackPrompt?: string;
  readonly action?: "authorize" | "connect";
}): string {
  const action =
    args.action ?? (args.slug.startsWith("_") ? "connect" : "authorize");
  const url = new URL(`/connectors/${args.slug}/${action}`, APP_ORIGIN);
  url.searchParams.set("threadId", RUN_THREAD_ID);
  if (args.callbackPrompt) {
    url.searchParams.set("callbackPrompt", args.callbackPrompt);
  }
  return url.href;
}

export function bankingActionUrl(args: {
  readonly reason: string;
  readonly callbackPrompt: string;
}): string {
  const url = new URL("/banking/access", APP_ORIGIN);
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
