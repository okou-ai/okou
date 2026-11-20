import { command } from "ccstate";
import { permissionGrantsToFirewallPolicies } from "@okouai/connectors/firewall-metadata/policy";
import type {
  FirewallPolicies,
  FirewallPolicy,
  NetworkPolicies,
  NetworkPolicy,
} from "@okouai/connectors/firewall-types";
import type { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { nowDate } from "../../lib/time";
import {
  defaultFirewallPolicyForPermissionIndex,
  networkPolicyForFirewallPolicy,
} from "./firewall-network-policy.service";
import type { ConnectorRuntimeLookup } from "./connector-catalog-runtime.service";
import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";

export type ResolvedPermissionGrant = Pick<
  typeof connectorPermissionGrants.$inferSelect,
  "permission" | "action" | "expiresAt"
> & { readonly connectorSlug: string };

interface ActiveNetworkPolicyRefresh {
  readonly connectorSlug: string;
  readonly networkPolicy: NetworkPolicy;
  readonly nextRefreshAt: string | null;
}

interface ConnectorPermissionPolicyBaseline {
  readonly connectorSlug: string;
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
}

function earliestTemporaryAllowExpiresAt(
  grants: readonly ResolvedPermissionGrant[],
  connectorSlug: string,
): Date | null {
  let earliest: Date | null = null;
  for (const grant of grants) {
    if (
      grant.connectorSlug !== connectorSlug ||
      grant.action !== "allow" ||
      !grant.expiresAt
    ) {
      continue;
    }
    if (!earliest || grant.expiresAt.getTime() < earliest.getTime()) {
      earliest = grant.expiresAt;
    }
  }
  return earliest;
}

function resolvedConnectorFirewallPolicies(
  grants: readonly ResolvedPermissionGrant[],
): FirewallPolicies {
  return permissionGrantsToFirewallPolicies(grants) ?? {};
}

function networkPolicyRefreshConnectorSlugs(
  catalog: ConnectorServerFirewallMetadataCatalog,
  connectorSlugs: readonly string[],
): string[] {
  return [
    ...new Set(
      connectorSlugs.filter((connectorSlug) => {
        return catalog.has(connectorSlug);
      }),
    ),
  ];
}

/** Runtime callers supply their captured catalog; the finite read remains
 * awaited by their existing read group and its cancellation boundary. */
export const readActiveNetworkPolicyRefreshes$ = command(
  async (
    _context,
    args: {
      readonly connectorSlugs: readonly string[];
      readonly snapshot: Pick<ConnectorRuntimeLookup, "serverFirewalls">;
      readonly memberRules: readonly ResolvedPermissionGrant[];
    },
    checkedAt: Date = nowDate(),
  ): Promise<readonly ActiveNetworkPolicyRefresh[]> => {
    const { connectorSlugs, snapshot } = args;
    if (connectorSlugs.length === 0) {
      return [];
    }

    const uniqueConnectorSlugs = networkPolicyRefreshConnectorSlugs(
      snapshot.serverFirewalls,
      connectorSlugs,
    );
    if (uniqueConnectorSlugs.length === 0) {
      return [];
    }

    return await activeNetworkPolicyRefreshesFromGrants(
      {
        catalog: snapshot.serverFirewalls,
        connectorSlugs: uniqueConnectorSlugs,
        grants: args.memberRules,
      },
      checkedAt,
    );
  },
);

/** Captured sources can outlive a temporary grant while a Run is prepared. */
export async function activeNetworkPolicyRefreshesFromGrants(
  args: {
    readonly catalog: ConnectorServerFirewallMetadataCatalog;
    readonly connectorSlugs: readonly string[];
    readonly grants: readonly ResolvedPermissionGrant[];
  },
  checkedAt: Date,
): Promise<readonly ActiveNetworkPolicyRefresh[]> {
  const indexes = await Promise.all(
    networkPolicyRefreshConnectorSlugs(args.catalog, args.connectorSlugs).map(
      async (connectorSlug) => {
        return {
          connectorSlug,
          index: await args.catalog.loadPermissionIndex(connectorSlug),
        };
      },
    ),
  );
  return activeNetworkPolicyRefreshesForPermissionBaselines(
    indexes.flatMap(({ connectorSlug, index }) => {
      return index
        ? [
            {
              connectorSlug,
              permissionNames: [...index.permissionNames],
              defaultPolicy: defaultFirewallPolicyForPermissionIndex(index),
            },
          ]
        : [];
    }),
    args.grants.filter((grant) => {
      return grant.expiresAt === null || grant.expiresAt > checkedAt;
    }),
  );
}

function activeNetworkPolicyRefreshesForPermissionBaselines(
  baselines: readonly ConnectorPermissionPolicyBaseline[],
  grants: readonly ResolvedPermissionGrant[],
): readonly ActiveNetworkPolicyRefresh[] {
  const policies = resolvedConnectorFirewallPolicies(grants);
  return baselines.map((baseline) => {
    const defaultPolicy = baseline.defaultPolicy;
    const connectorSlug = baseline.connectorSlug;
    const overlay = policies[connectorSlug];
    const policy: FirewallPolicy = overlay
      ? {
          policies: { ...defaultPolicy.policies, ...overlay.policies },
          unknownPolicy: overlay.unknownPolicy ?? defaultPolicy.unknownPolicy,
        }
      : defaultPolicy;
    const nextRefreshAt = earliestTemporaryAllowExpiresAt(
      grants,
      connectorSlug,
    );
    return {
      connectorSlug,
      networkPolicy: networkPolicyForFirewallPolicy(
        baseline.permissionNames,
        policy,
      ),
      nextRefreshAt: nextRefreshAt?.toISOString() ?? null,
    };
  });
}

export function networkPolicyRefreshesRecord(
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): Record<string, { readonly nextRefreshAt: string }> | undefined {
  const entries = refreshes.flatMap((refresh) => {
    if (refresh.nextRefreshAt === null) {
      return [];
    }
    return [
      [
        refresh.connectorSlug,
        { nextRefreshAt: refresh.nextRefreshAt },
      ] as const,
    ];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function mergeNetworkPolicyRefreshes(
  networkPolicies: NetworkPolicies,
  refreshes: readonly ActiveNetworkPolicyRefresh[],
): NetworkPolicies {
  const merged: NetworkPolicies = { ...networkPolicies };
  for (const refresh of refreshes) {
    // Refreshes are scoped to admitted builtin targets, whose captured policy
    // entries may be omitted. Preserve unrelated captured entries as-is.
    merged[refresh.connectorSlug] = refresh.networkPolicy;
  }
  return merged;
}
