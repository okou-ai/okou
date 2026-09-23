import { command, computed } from "ccstate";
import { getAllFeatureStates } from "@okouai/core/feature-switch";
import { isIntegrationManagedCustomConnector } from "@okouai/api-contracts/contracts/custom-connectors";
import { connectorOverviewContract } from "@okouai/api-contracts/contracts/connector-overview";

import {
  resourceUnavailable,
  providerUnavailable,
  notFound,
} from "../../lib/error";
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
import { connectorActionResolver } from "../services/connector-action-resolver.service";
import { listConnectorAccountSummaries } from "../services/connector-account-lifecycle.service";
import {
  isConnectorCatalogUnavailableError,
  listConnectedConnectorBriefs,
} from "../services/connector-catalog-reader.service";
import { listAdmittedComputerUseHosts$ } from "../services/computer-use-host-directory-erasure-admission.service";
import { customConnectorList } from "../services/custom-connector-list.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { userPreferences } from "../services/user-data.service";
import { settle } from "../utils";

const overview$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const owner = { orgId: auth.orgId, userId: auth.userId };
  const db = get(db$);
  const [summaries, customConnectors, preferences, hosts, overrides] =
    await Promise.all([
      listConnectorAccountSummaries(db, owner),
      get(customConnectorList(owner)),
      get(userPreferences(owner)),
      set(listAdmittedComputerUseHosts$, owner, signal),
      get(userFeatureSwitchOverrides(auth.orgId, auth.userId)),
    ]);
  signal.throwIfAborted();
  if (hosts.outcome !== "listed") {
    return resourceUnavailable("Computer-use host directory is unavailable");
  }

  const connectedSlugs = summaries.flatMap((summary) => {
    return summary.target.kind === "builtin" && summary.accountCount > 0
      ? [summary.target.connectorSlug]
      : [];
  });
  const catalog = await settle(
    listConnectedConnectorBriefs({
      db,
      featureStates: getAllFeatureStates({ ...owner, overrides }),
      connectorSlugs: connectedSlugs,
    }),
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
  const connectedCustom = customConnectors.filter((connector) => {
    return connector.connected;
  });
  const connectedCustomIds = new Set(
    connectedCustom.map((connector) => {
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
      customConnectors: connectedCustom.map((connector) => {
        return {
          id: connector.id,
          slug: connector.slug,
          displayName: connector.displayName,
          permissionBundleRef: connector.permissionBundleRef ?? null,
          integrationManaged: isIntegrationManagedCustomConnector(connector),
        };
      }),
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
                }
              : null,
          };
        }),
      computerUseHosts: hosts.value.hosts.map((host) => {
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
  const enabledConnectorSlugs = [];
  if (slugs.length > 0) {
    const resolver = await get(connectorActionResolver());
    for (const connectorSlug of slugs) {
      const resolved = await resolver.resolveSlug({
        connectorSlug,
        requireExecutable: true,
      });
      if (resolved.ok) {
        enabledConnectorSlugs.push(connectorSlug);
      }
    }
  }
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
