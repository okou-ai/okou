import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import {
  ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  onboardingSourcesContract,
} from "@okouai/api-contracts/contracts/onboarding";
import type { BuiltinConnectorResponse } from "@okouai/api-contracts/contracts/connector-schemas";

import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

/** One onboarding source that connects through a single OAuth method. */
export function onboardingSourceItem(item: {
  readonly slug: PublicConnectorCatalogStatusItem["slug"];
  readonly label: string;
  readonly description: string;
  readonly connected: boolean;
}): PublicConnectorCatalogStatusItem {
  return {
    slug: item.slug,
    label: item.label,
    description: item.description,
    icon: {
      url: `https://icons.example.test/onboarding-${item.slug}.svg`,
      invertInDarkMode: false,
    },
    category: "productivity",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "OAuth",
        description: null,
        grantKind: "auth-code",
        manualFields: [],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    connection: null,
    connected: item.connected,
    connectionStatus: item.connected ? "connected" : "not-connected",
    scopeMismatch: false,
    authMethodSupportsRefresh: false,
    tokenExpiresAt: null,
    singleAuthCodeAuthMethodId: "oauth",
    connectNotice: null,
  };
}

/** Gmail, connected: the source every step after the source step requires. */
export function connectedGmailSource(): PublicConnectorCatalogStatusItem {
  return onboardingSourceItem({
    slug: "gmail",
    label: "Gmail",
    description: "Connect Gmail to continue",
    connected: true,
  });
}

function builtinConnection(
  item: PublicConnectorCatalogStatusItem,
): BuiltinConnectorResponse {
  return {
    id: crypto.randomUUID(),
    slug: item.slug,
    authMethod: item.authMethods[0]?.id ?? "oauth",
    externalId: null,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    connectionStatus: "connected",
    reconnectReason: null,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * The connector data the source-first onboarding reads, built from full
 * catalog entries:
 * - `GET /api/onboarding/sources` lists the entries that are onboarding
 *   sources, projected to connect items. `ready` holds the response back and
 *   `unavailable` answers 503 instead.
 * - the user's connections (`GET /api/connectors`) hold one per connected
 *   entry, which the guard of every step after the source step reads.
 * - `GET /api/connector-catalog/:slug` answers the connect modal with the full
 *   entry, and 404 for any other slug. It is installed first so the static
 *   catalog routes registered after it are not read as a slug.
 */
export function mockOnboardingConnectorCatalog(
  context: TestContext,
  items: readonly PublicConnectorCatalogStatusItem[],
  options: {
    readonly ready?: Promise<void>;
    readonly unavailable?: () => boolean;
  } = {},
): void {
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    const connector = items.find((item) => {
      return item.slug === params.connectorSlug;
    });
    if (!connector) {
      return respond(404, {
        error: { message: "Connector not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, { connector });
  });

  const onboardingSlugs = new Set<string>(
    ONBOARDING_RECOMMENDATION_CONNECTOR_SLUGS,
  );
  context.mocks.api(onboardingSourcesContract.list, async ({ respond }) => {
    if (options.ready) {
      await options.ready;
    }
    if (options.unavailable?.()) {
      return respond(503, {
        error: {
          code: "PROVIDER_UNAVAILABLE",
          message: "Connector catalog is temporarily unavailable",
        },
      });
    }
    return respond(200, {
      connectors: items.flatMap((item) => {
        return onboardingSlugs.has(item.slug)
          ? [connectorCatalogConnectItem(item)]
          : [];
      }),
    });
  });

  context.mocks.data.connectors(
    items.flatMap((item) => {
      return item.connected ? [builtinConnection(item)] : [];
    }),
  );
}
