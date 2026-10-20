import type {
  PublicConnectorCatalogAuthMethodDetail,
  PublicConnectorCatalogAuthMethodSummary,
  PublicConnectorCatalogItem,
  PublicConnectorCatalogManualField,
  PublicConnectorCatalogPermissionDetail,
  PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { http, HttpResponse } from "msw";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";

export interface CatalogFixtureAccount {
  readonly connection?:
    | (Partial<Pick<ConnectorAccountConnection, "id">> &
        Pick<
          ConnectorAccountConnection,
          | "authMethod"
          | "externalUsername"
          | "externalEmail"
          | "reconnectReason"
        >)
    | null;
  readonly connectionStatus?:
    "connected" | "not-connected" | "scope-mismatch" | "reconnect-required";
  readonly connected?: boolean;
  readonly scopeMismatch?: boolean;
  readonly authMethodSupportsRefresh?: boolean;
  readonly tokenExpiresAt?: string | null;
}
const catalogFixtureAccounts = new WeakMap<
  PublicConnectorCatalogStatusItem,
  CatalogFixtureAccount
>();
export function catalogFixtureAccount(item: PublicConnectorCatalogStatusItem) {
  return catalogFixtureAccounts.get(item);
}

function permissionSummary(): PublicConnectorCatalogStatusItem["permissionSummary"] {
  return {
    hasPermissions: false,
    permissionCount: 0,
    hasCategories: false,
    hasDefaultPolicyOverrides: false,
  };
}

function manualField(
  id: string,
  label = id,
): PublicConnectorCatalogManualField {
  return {
    id,
    label,
    required: true,
    placeholder: null,
    inputType: "password",
  };
}

export function manualAuthMethod(
  id = "api-token",
  fields: readonly PublicConnectorCatalogManualField[] = [
    manualField("apiKey"),
  ],
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: id,
    description: null,
    grantKind: "manual",
    supportsRefresh: false,
    manualFields: [...fields],
    startOptions: [],
  };
}

export function authCodeMethod(
  id = "oauth",
): PublicConnectorCatalogAuthMethodDetail {
  return {
    id,
    label: id,
    description: null,
    grantKind: "auth-code",
    supportsRefresh: true,
    manualFields: [],
    startOptions: [],
  };
}

function authMethodSummary(
  method: PublicConnectorCatalogAuthMethodSummary,
): PublicConnectorCatalogAuthMethodSummary {
  return {
    id: method.id,
    label: method.label,
    description: method.description,
    grantKind: method.grantKind,
    supportsRefresh: method.supportsRefresh,
  };
}

export function catalogItem(
  overrides: Partial<PublicConnectorCatalogItem> & {
    readonly connectorSlug: string;
  },
): PublicConnectorCatalogItem {
  return {
    slug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    description:
      overrides.description ?? `${overrides.connectorSlug} connector`,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: overrides.category ?? "developer-tools",
    generation: overrides.generation ?? [],
    tags: overrides.tags ?? [],
    authMethods: (overrides.authMethods ?? []).map(authMethodSummary),
    permissionSummary: overrides.permissionSummary ?? permissionSummary(),
  };
}

export function catalogStatusItem(
  overrides: Partial<PublicConnectorCatalogStatusItem> &
    CatalogFixtureAccount & {
      readonly connectorSlug: string;
    },
): PublicConnectorCatalogStatusItem {
  const item: PublicConnectorCatalogStatusItem = {
    slug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    description:
      overrides.description ?? `${overrides.connectorSlug} connector`,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    category: overrides.category ?? "developer-tools",
    generation: overrides.generation ?? [],
    tags: overrides.tags ?? [],
    authMethods: overrides.authMethods ?? [],
    permissionSummary: overrides.permissionSummary ?? permissionSummary(),
    singleAuthCodeAuthMethodId: overrides.singleAuthCodeAuthMethodId ?? null,
    connectNotice: overrides.connectNotice ?? null,
  };
  catalogFixtureAccounts.set(item, overrides);
  return item;
}

export function catalogPermissionDetail(
  overrides: Partial<PublicConnectorCatalogPermissionDetail> & {
    readonly connectorSlug: string;
  },
): PublicConnectorCatalogPermissionDetail {
  const permissions = overrides.permissions ?? [];
  return {
    connectorSlug: overrides.connectorSlug,
    label: overrides.label ?? overrides.connectorSlug,
    icon: overrides.icon ?? {
      url: `https://icons.example.test/${overrides.connectorSlug}.svg`,
      invertInDarkMode: false,
    },
    permissionCount: overrides.permissionCount ?? permissions.length,
    permissions,
    categories: overrides.categories ?? null,
    defaultPolicy: overrides.defaultPolicy ?? {
      permissionDefault: "allow",
      unknownPolicy: "allow",
    },
  };
}

export function stubConnectorCatalog(
  connectors: readonly PublicConnectorCatalogItem[],
  origin = "http://localhost:3000",
) {
  return http.get(`${origin}/api/connector-catalog`, () => {
    return HttpResponse.json({ connectors });
  });
}

export function stubConnectorCatalogDetail(
  connectors: readonly PublicConnectorCatalogStatusItem[],
  origin = "http://localhost:3000",
) {
  return http.get(
    `${origin}/api/connector-catalog/:connectorSlug`,
    ({ params }) => {
      const connector = connectors.find((item) => {
        return item.slug === params.connectorSlug;
      });
      return connector
        ? HttpResponse.json({ connector })
        : HttpResponse.json(
            {
              error: {
                code: "NOT_FOUND",
                message: "Connector catalog item not found",
              },
            },
            { status: 404 },
          );
    },
  );
}

export function stubConnectorCatalogPermissions(
  details: readonly PublicConnectorCatalogPermissionDetail[],
  origin = "http://localhost:3000",
) {
  const detailsBySlug = new Map(
    details.map((detail) => {
      return [detail.connectorSlug, detail] as const;
    }),
  );
  return http.get(
    `${origin}/api/connector-catalog/:connectorSlug/permissions`,
    ({ params }) => {
      const connectorSlug = String(params.connectorSlug);
      const permissions = detailsBySlug.get(connectorSlug);
      if (!permissions) {
        return HttpResponse.json(
          {
            error: {
              message: "Connector catalog item not found",
              code: "NOT_FOUND",
            },
          },
          { status: 404 },
        );
      }
      return HttpResponse.json({ permissions });
    },
  );
}
