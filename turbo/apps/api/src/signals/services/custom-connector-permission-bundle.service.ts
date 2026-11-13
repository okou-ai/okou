import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  customConnectorFirewallSchema,
  type CustomConnectorFirewall,
  type CustomConnectorPermissionBundleRef,
} from "@okouai/api-contracts/contracts/custom-connectors";
import type {
  ExpandedFirewallConfig,
  FirewallPolicyValue,
} from "@okouai/connectors/firewall-types";

import type { ConnectorServerFirewallMetadataCatalog } from "./connector-server-firewall-catalog.service";
import {
  FEISHU_CUSTOM_CONNECTOR_DEFAULT_POLICIES,
  FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF,
  FEISHU_CUSTOM_CONNECTOR_PERMISSIONS,
} from "./feishu-custom-connector-permissions";

const PERMISSION_BUNDLE_REF_PATTERN = /^builtin:([^@]+)@1$/u;

type FirewallPermissions = NonNullable<
  ExpandedFirewallConfig["apis"][number]["permissions"]
>;

export interface CustomConnectorPermissionBundle {
  readonly ref: CustomConnectorPermissionBundleRef;
  readonly connectorSlug: ConnectorSlug;
  readonly permissionNames: ReadonlySet<string>;
  readonly permissions: FirewallPermissions;
  readonly defaultPolicies: Readonly<Record<string, FirewallPolicyValue>>;
}

export function customConnectorPermissionBundleDependencySlug(
  ref: string,
): ConnectorSlug | null {
  if (
    ref === FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF ||
    ref === "builtin:custom@1"
  ) {
    return null;
  }
  const match = PERMISSION_BUNDLE_REF_PATTERN.exec(ref);
  const parsed = connectorSlugSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : null;
}

export async function loadCustomConnectorPermissionBundle(args: {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly ref: CustomConnectorPermissionBundleRef;
  readonly firewall?: CustomConnectorFirewall | null;
}): Promise<CustomConnectorPermissionBundle | null> {
  if (args.ref === "builtin:custom@1") {
    const parsed = customConnectorFirewallSchema.safeParse(args.firewall);
    if (!parsed.success) {
      return null;
    }
    return {
      ref: args.ref,
      connectorSlug: "custom",
      permissionNames: new Set(
        parsed.data.permissions.map((permission) => {
          return permission.name;
        }),
      ),
      permissions: parsed.data.permissions.map(
        ({ defaultPolicy: _defaultPolicy, ...permission }) => {
          return permission;
        },
      ),
      defaultPolicies: Object.fromEntries(
        parsed.data.permissions.map((permission) => {
          return [permission.name, permission.defaultPolicy];
        }),
      ),
    };
  }
  if (args.ref === FEISHU_CUSTOM_CONNECTOR_PERMISSION_BUNDLE_REF) {
    return {
      ref: args.ref,
      connectorSlug: "feishu",
      permissionNames: new Set(
        FEISHU_CUSTOM_CONNECTOR_PERMISSIONS.map((permission) => {
          return permission.name;
        }),
      ),
      permissions: [...FEISHU_CUSTOM_CONNECTOR_PERMISSIONS],
      defaultPolicies: FEISHU_CUSTOM_CONNECTOR_DEFAULT_POLICIES,
    };
  }

  const connectorSlug = customConnectorPermissionBundleDependencySlug(args.ref);
  if (
    !connectorSlug ||
    !args.catalog.has(connectorSlug) ||
    args.catalog.isMcp(connectorSlug)
  ) {
    return null;
  }

  const [permissionIndex, routingMetadata] = await Promise.all([
    args.catalog.loadPermissionIndex(connectorSlug),
    args.catalog.loadRoutingMetadata(connectorSlug),
  ]);
  if (!permissionIndex || !routingMetadata) {
    return null;
  }

  const rulesByPermission = new Map<string, Set<string>>(
    [...permissionIndex.permissionNames].map((permissionName) => {
      return [permissionName, new Set<string>()];
    }),
  );
  for (const api of routingMetadata.apis) {
    for (const route of api.routes) {
      rulesByPermission.get(route.permissionName)?.add(route.rule);
    }
  }

  const permissionNames = new Set(
    [...permissionIndex.permissionNames].sort((left, right) => {
      return left.localeCompare(right);
    }),
  );
  const permissions: FirewallPermissions = [...permissionNames].map((name) => {
    const description = permissionIndex.permissionDescription(name);
    return {
      name,
      ...(description ? { description } : {}),
      rules: [...(rulesByPermission.get(name) ?? [])].sort((left, right) => {
        return left.localeCompare(right);
      }),
    };
  });
  return {
    ref: args.ref,
    connectorSlug,
    permissionNames,
    permissions,
    defaultPolicies: Object.fromEntries(
      [...permissionNames].map((permissionName) => {
        return [permissionName, "deny" as const];
      }),
    ),
  };
}
