import {
  permissionGrantsToFirewallPolicies,
  resolveFirewallMetadataPolicies,
} from "@okouai/connectors/firewall-metadata/policy";
import type {
  FirewallPolicies,
  FirewallPolicyValue,
} from "@okouai/connectors/firewall-types";
import {
  getConnectorCatalogPermissions,
  type ConnectorCatalogPermissionDetail,
} from "../../lib/api/domains/connectors";
import type { UserPermissionGrant } from "../../lib/api/domains/agents";

export interface ConnectorPermissionInfo {
  readonly connectorSlug: string;
  readonly hasPermissions: boolean;
  readonly hasPolicyEntry: boolean;
  readonly permissions: readonly ConnectorCatalogPermissionDetail["permissions"][number][];
  readonly policies: Readonly<Record<string, FirewallPolicyValue>> | null;
  readonly unknownPolicy: FirewallPolicyValue;
  readonly allowed: number;
  readonly total: number;
}

type PermissionMetadataBySlug = Map<
  string,
  ConnectorCatalogPermissionDetail | null
>;

async function loadPermissionMetadataBySlug(
  connectorSlugs: readonly string[],
): Promise<PermissionMetadataBySlug> {
  const uniqueConnectorSlugs = [...new Set(connectorSlugs)];
  const entries = await Promise.all(
    uniqueConnectorSlugs.map(async (connectorSlug) => {
      return [
        connectorSlug,
        await getConnectorCatalogPermissions(connectorSlug),
      ] as const;
    }),
  );
  return new Map(entries);
}

function connectorPermissionInfo(args: {
  readonly connectorSlug: string;
  readonly metadata: ConnectorCatalogPermissionDetail | null;
  readonly resolvedPolicies: FirewallPolicies | null;
}): ConnectorPermissionInfo {
  if (!args.metadata) {
    return {
      connectorSlug: args.connectorSlug,
      hasPermissions: false,
      hasPolicyEntry: false,
      permissions: [],
      policies: null,
      unknownPolicy: "allow",
      allowed: 0,
      total: 0,
    };
  }

  const connectorPolicy = args.resolvedPolicies?.[args.metadata.connectorSlug];
  const policies =
    connectorPolicy && Object.keys(connectorPolicy.policies).length > 0
      ? connectorPolicy.policies
      : null;
  const total = args.metadata.permissions.length;
  const allowed = policies
    ? args.metadata.permissions.filter((permission) => {
        return policies[permission.name] === "allow";
      }).length
    : 0;

  return {
    connectorSlug: args.connectorSlug,
    hasPermissions: true,
    hasPolicyEntry: connectorPolicy !== undefined,
    permissions: args.metadata.permissions,
    policies,
    unknownPolicy: connectorPolicy?.unknownPolicy ?? "allow",
    allowed,
    total,
  };
}

export async function loadConnectorPermissionInfos(args: {
  readonly displayConnectorSlugs: readonly string[];
  readonly defaultPolicyConnectorSlugs: readonly string[];
  readonly storedPolicies: FirewallPolicies | null;
}): Promise<ConnectorPermissionInfo[]> {
  const metadataBySlug = await loadPermissionMetadataBySlug([
    ...args.displayConnectorSlugs,
    ...args.defaultPolicyConnectorSlugs,
  ]);
  const defaultPolicyMetadata = args.defaultPolicyConnectorSlugs.flatMap(
    (connectorSlug) => {
      const metadata = metadataBySlug.get(connectorSlug);
      return metadata ? [metadata] : [];
    },
  );
  const resolvedPolicies = resolveFirewallMetadataPolicies(
    args.storedPolicies,
    defaultPolicyMetadata,
  );

  return args.displayConnectorSlugs.map((connectorSlug) => {
    return connectorPermissionInfo({
      connectorSlug,
      metadata: metadataBySlug.get(connectorSlug) ?? null,
      resolvedPolicies,
    });
  });
}

export function connectorPermissionGrantsToFirewallPolicies(
  grants: readonly Pick<
    UserPermissionGrant,
    "connectorSlug" | "permission" | "action"
  >[],
): FirewallPolicies | null {
  return permissionGrantsToFirewallPolicies(grants);
}
