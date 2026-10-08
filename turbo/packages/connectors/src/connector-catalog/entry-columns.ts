import type { ConnectorCatalogArtifactConnector } from "./artifacts/artifacts";
import { deriveConnectorCatalogFirewallPermissions } from "./artifacts/relationships";

export interface ConnectorCatalogPermissionSummary {
  readonly hasPermissions: boolean;
  readonly permissionCount: number;
  readonly hasCategories: boolean;
  readonly hasDefaultPolicyOverrides: boolean;
}

interface ConnectorCatalogDefaultPolicy {
  readonly permissionDefault: "allow" | "deny";
  readonly permissionOverrides?: {
    readonly allow?: string[];
    readonly deny?: string[];
  };
  readonly unknownPolicy: Extract<
    ConnectorCatalogArtifactConnector["firewall"],
    { readonly kind: "generated" }
  >["defaultUnknownPolicy"];
}

/** The catalog's existing compact policy, shared by summary writes and detail reads. */
export function compactConnectorCatalogDefaultPolicy(
  connector: Pick<ConnectorCatalogArtifactConnector, "firewall">,
): ConnectorCatalogDefaultPolicy {
  if (connector.firewall.kind === "none") {
    throw new Error("Connector catalog firewall metadata is unavailable");
  }
  const permissionNames = deriveConnectorCatalogFirewallPermissions(
    connector.firewall.config.apis,
  ).map((permission) => {
    return permission.name;
  });
  const allowed =
    connector.firewall.defaultAllowed === null
      ? new Set(permissionNames)
      : new Set(connector.firewall.defaultAllowed);
  const allowCount = permissionNames.filter((permission) => {
    return allowed.has(permission);
  }).length;
  const permissionDefault =
    permissionNames.length - allowCount > allowCount ? "deny" : "allow";
  const overrides = permissionNames.filter((permission) => {
    return allowed.has(permission) !== (permissionDefault === "allow");
  });
  const overrideValue = permissionDefault === "allow" ? "deny" : "allow";
  return {
    permissionDefault,
    ...(overrides.length === 0
      ? {}
      : { permissionOverrides: { [overrideValue]: overrides } }),
    unknownPolicy: connector.firewall.defaultUnknownPolicy,
  };
}

/** Computed once at preparation time; list readers never load firewall rules. */
export function connectorCatalogPermissionSummary(
  connector: Pick<ConnectorCatalogArtifactConnector, "mcp" | "firewall">,
): ConnectorCatalogPermissionSummary {
  if (connector.mcp !== undefined || connector.firewall.kind === "none") {
    return {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    };
  }
  const permissionCount = deriveConnectorCatalogFirewallPermissions(
    connector.firewall.config.apis,
  ).length;
  const defaultPolicy = compactConnectorCatalogDefaultPolicy(connector);
  return {
    hasPermissions: permissionCount > 0,
    permissionCount,
    hasCategories: connector.firewall.categories !== null,
    hasDefaultPolicyOverrides:
      defaultPolicy.permissionDefault !== "allow" ||
      defaultPolicy.unknownPolicy !== "allow" ||
      defaultPolicy.permissionOverrides !== undefined,
  };
}

/** Independent columns written alongside payload during the expand release. */
export function connectorCatalogEntryColumns(
  connector: ConnectorCatalogArtifactConnector,
) {
  return {
    label: connector.label,
    description: connector.description,
    category: connector.category,
    icon: connector.icon,
    tags: connector.tags,
    generation: connector.generation,
    authMethods: connector.authMethods,
    mcp: connector.mcp ?? null,
    skill: connector.skill,
    firewall: connector.firewall,
    permissionSummary: connectorCatalogPermissionSummary(connector),
  };
}
