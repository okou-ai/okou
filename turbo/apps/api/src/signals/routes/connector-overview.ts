import { command, computed } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";

import { providerUnavailable, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  agentCustomConnectorGrants,
  agentEnabledConnectorSlugs,
  agentExists,
} from "../services/agent-data.service";
import { executableConnectorSlugs } from "../services/connector-action-resolver.service";
import { connectorAccountSummaries } from "../services/connector-account-lifecycle.service";
import {
  isConnectorCatalogUnavailableError,
  connectorBriefsFromRows,
} from "../services/connector-catalog-reader.service";
import { connectorCatalogDisplayColumns } from "../services/connector-catalog-columns";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
} from "../services/connector-catalog-slug-source.service";
import { listComputerUseHosts$ } from "../services/computer-use.service";
import { customConnectorOverview } from "../services/custom-connector-overview.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { userPreferences } from "../services/user-data.service";
import { settle } from "../utils";

const accountSummaries$ = connectorAccountSummaries(organizationAuthContext$);
const customConnectors$ = customConnectorOverview(
  organizationAuthContext$,
  accountSummaries$,
);

const overview$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const owner = { orgId: auth.orgId, userId: auth.userId };
  const db = get(db$);
  const [summaries, customConnectors, preferences, hosts, overrides] =
    await Promise.all([
      get(accountSummaries$),
      get(customConnectors$),
      get(userPreferences(owner)),
      set(listComputerUseHosts$, owner, signal),
      get(userFeatureSwitchOverrides(auth.orgId, auth.userId)),
    ]);
  signal.throwIfAborted();

  const connectedSlugs = summaries.flatMap((summary) => {
    return summary.target.kind === "builtin" && summary.accountCount > 0
      ? [summary.target.connectorSlug]
      : [];
  });
  const featureStates = getAllFeatureStates({ ...owner, overrides });
  const catalog = await settle(
    connectedSlugs.length === 0
      ? Promise.resolve([])
      : (async () => {
          const rows = await db
            .select({
              current: {
                schemaVersion: connectorCatalog.schemaVersion,
                hash: connectorCatalog.hash,
              },
              entry: connectorCatalogDisplayColumns,
            })
            .from(connectorCatalog)
            .leftJoin(
              connectorCatalogEntries,
              connectorCatalogSlugJoin(connectedSlugs),
            )
            .where(connectorCatalogCurrentWhere());
          return connectorBriefsFromRows({
            rows,
            featureStates,
            connectorSlugs: connectedSlugs,
          });
        })(),
    signal,
  );
  if (!catalog.ok) {
    if (isConnectorCatalogUnavailableError(catalog.error)) {
      return providerUnavailable(
        "Connector catalog is temporarily unavailable",
      );
    }
    throw catalog.error;
  }
  const connectedCustomIds = new Set(
    customConnectors.map((connector) => {
      return connector.id;
    }),
  );
  const connectedBuiltinSlugs = new Set(
    catalog.value.map((connector) => {
      return connector.slug;
    }),
  );
  return {
    status: 200 as const,
    body: {
      builtinConnectors: [...catalog.value],
      customConnectors,
      accountSummaries: summaries
        .filter((summary) => {
          return summary.target.kind === "builtin"
            ? connectedBuiltinSlugs.has(summary.target.connectorSlug)
            : connectedCustomIds.has(summary.target.customConnectorId);
        })
        .map((summary) => {
          const account = summary.defaultConnection;
          return {
            target: summary.target,
            accountCount: summary.accountCount,
            attentionCount: summary.attentionCount,
            defaultConnection: account
              ? {
                  id: account.id,
                  authMethod: account.authMethod,
                  displayName: account.displayName,
                  externalId: account.externalId,
                  externalUsername: account.externalUsername,
                  externalEmail: account.externalEmail,
                  connectionStatus: account.connectionStatus,
                  setupStatus: account.setupStatus,
                  missingRequiredFields: account.missingRequiredFields,
                  configuredFieldKeys: account.configuredFieldKeys,
                }
              : null,
          };
        }),
      computerUseHosts: hosts.hosts.map((host) => {
        return {
          id: host.id,
          hostName: host.hostName ?? host.displayName,
          displayName: host.displayName,
          lastSeenAt: host.lastSeenAt,
          status: host.status,
        };
      }),
      cloudBrowserEnabledByDefault: preferences.cloudBrowserEnabledByDefault,
    },
  };
});

const agent$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const { id: agentId } = get(pathParamsOf(connectorOverviewContract.agent));
  const owner = { orgId: auth.orgId, userId: auth.userId, agentId };
  if (!(await get(agentExists(owner)))) {
    return notFound(`Agent not found: ${agentId}`);
  }
  const [slugs, grants] = await Promise.all([
    get(agentEnabledConnectorSlugs(owner)),
    get(agentCustomConnectorGrants(owner)),
  ]);
  const enabledConnectorSlugs = await get(executableConnectorSlugs(slugs));
  return {
    status: 200 as const,
    body: {
      enabledConnectorSlugs,
      customConnectorIds: grants.map((grant) => {
        return grant.customConnectorId;
      }),
    },
  };
});

const readAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

export const connectorOverviewRoutes: readonly RouteEntry[] = [
  {
    route: connectorOverviewContract.overview,
    handler: authRoute(readAuth, overview$),
  },
  {
    route: connectorOverviewContract.agent,
    handler: authRoute(readAuth, agent$),
  },
];
