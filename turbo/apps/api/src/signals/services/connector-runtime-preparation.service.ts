/** Runtime connector capability shared by launch preparation and runtime sync. */
import type { ConnectorRuntimeTargetRegistration } from "@okouai/api-contracts/contracts/runners";
import {
  type ExecutionFirewallInlineEntry,
  type ExpandedFirewallConfig,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicy,
  extractSecretNamesFromApis,
} from "@okouai/connectors/firewall-types";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { safeSync } from "../utils";
import type { ConnectorRuntimeLookup } from "./connector-catalog-runtime.service";
import type { CustomConnectorCredentialAccess } from "./custom-connector-credential-access.service";
import { orderByCustomConnectorId } from "./custom-connector-order";
import { parseCustomMcpEndpoint } from "./custom-mcp-endpoint";
import {
  type CustomConnectorPermissionBundle,
  loadCustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import {
  CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME,
  CustomConnectorRuntimePrefixError,
  type CustomConnectorStoredValueRow,
  customConnectorInternalName,
  customConnectorPrefixTemplateVariableKeys,
  customConnectorValueMarkerKey,
  renderCustomConnectorRuntimePrefix,
  renderCustomConnectorTemplateForRuntime,
} from "./custom-connector.service";
import type { CustomConnectorExecutionDefinition } from "./custom-connector-definition-selection";
import { effectiveCustomConnectorPermissionBundleRef } from "./feishu-custom-connector-permissions";
import { networkPolicyForFirewallPolicy } from "./firewall-network-policy.service";

export interface CustomConnectorRuntimeContext {
  readonly firewalls: readonly ExpandedFirewallConfig[];
  readonly reservedSecretAliases: Record<string, true> | undefined;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly targets: readonly ConnectorRuntimeTargetRegistration[];
  readonly customConnectorIdByFirewallName: Readonly<Record<string, string>>;
  readonly customConnectorSourceIdByFirewallName: Readonly<
    Record<string, string>
  >;
}

export function compactRecord<T>(
  values: Record<string, T>,
): Record<string, T> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

export function mergeRecords<T>(
  ...records: readonly (Record<string, T> | undefined)[]
): Record<string, T> | undefined {
  const merged: Record<string, T> = {};
  for (const record of records) {
    if (record) {
      Object.assign(merged, record);
    }
  }
  return compactRecord(merged);
}

export type CustomConnectorRuntimeDataRows = readonly {
  readonly connector: CustomConnectorExecutionDefinition;
  readonly values: readonly (
    | Omit<
        Extract<CustomConnectorStoredValueRow, { readonly kind: "secret" }>,
        "encryptedValue"
      >
    | Extract<CustomConnectorStoredValueRow, { readonly kind: "variable" }>
  )[];
  readonly credentialAccess: CustomConnectorCredentialAccess;
}[];

function customConnectorRuntimeAuth(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
}): {
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
} {
  if (
    args.row.connector.authMode === "automatic" &&
    args.row.credentialAccess.kind === "current"
  ) {
    if (args.row.credentialAccess.resolvedAuthMethod === "none") {
      return { headers: {}, query: {} };
    }
    if (args.row.credentialAccess.resolvedAuthMethod === "oauth") {
      const authorization = renderCustomConnectorTemplateForRuntime({
        template: `Bearer {{oauth.${CUSTOM_CONNECTOR_OAUTH_ACCESS_TOKEN_SECRET_NAME}}}`,
        connectorId: args.row.connector.id,
        fields: args.row.connector.fields,
      });
      if (authorization === null) {
        throw new Error("Automatic OAuth runtime template is invalid");
      }
      return { headers: { Authorization: authorization }, query: {} };
    }
  }
  return {
    headers: Object.fromEntries(
      args.row.connector.headerInjections.flatMap((header) => {
        const rendered = renderCustomConnectorTemplateForRuntime({
          template: header.valueTemplate,
          connectorId: args.row.connector.id,
          fields: args.row.connector.fields,
        });
        return rendered === null ? [] : [[header.name, rendered]];
      }),
    ),
    query: Object.fromEntries(
      args.row.connector.queryInjections.flatMap((queryInjection) => {
        const rendered = renderCustomConnectorTemplateForRuntime({
          template: queryInjection.valueTemplate,
          connectorId: args.row.connector.id,
          fields: args.row.connector.fields,
        });
        return rendered === null ? [] : [[queryInjection.name, rendered]];
      }),
    ),
  };
}

function buildCustomConnectorRuntimeApis(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
  readonly baseUrlVars: Readonly<Record<string, string>>;
  readonly permissionBundle: CustomConnectorPermissionBundle | null;
}): ExpandedFirewallConfig["apis"] {
  const connector = args.row.connector;
  if (connector.kind === "mcp") {
    const endpointResult = parseCustomMcpEndpoint(connector.endpoint);
    if ("error" in endpointResult) {
      return [];
    }
    return [
      {
        base: endpointResult.ok.firewallBase,
        hostPolicy: { kind: "publicDestination" },
        auth: { headers: args.headers, query: args.query },
      },
    ];
  }
  const templateValues = Object.fromEntries(
    Object.entries(args.baseUrlVars).map(([key, value]) => {
      return [customConnectorValueMarkerKey({ kind: "variable", key }), value];
    }),
  );

  const apis: ExpandedFirewallConfig["apis"] = [];
  for (const prefixTemplate of connector.prefixTemplates) {
    const renderedPrefix = renderCustomConnectorRuntimePrefix({
      template: prefixTemplate,
      values: templateValues,
      connectorName: connector.displayName,
    });
    if (!renderedPrefix) {
      continue;
    }
    apis.push({
      base: renderedPrefix,
      auth: { headers: args.headers, query: args.query },
      ...(args.permissionBundle
        ? { permissions: [...args.permissionBundle.permissions] }
        : {}),
    });
  }
  return apis;
}

export function resolveCustomConnectorBaseUrlVars(
  row: CustomConnectorRuntimeDataRows[number],
): Readonly<Record<string, string>> | undefined {
  if (row.connector.kind === "mcp") {
    return {};
  }
  const variableKeys = [
    ...customConnectorPrefixTemplateVariableKeys(row.connector.prefixTemplates),
  ].sort();
  if (variableKeys.length === 0) {
    return {};
  }
  const prefixValues = row.values.filter(
    (
      value,
    ): value is Extract<
      CustomConnectorStoredValueRow,
      { readonly kind: "variable" }
    > => {
      return value.kind === "variable" && variableKeys.includes(value.key);
    },
  );
  if (prefixValues.length !== variableKeys.length) {
    return undefined;
  }
  const valuesByKey = new Map(
    prefixValues.map((value) => {
      return [value.key, value.value] as const;
    }),
  );
  const baseUrlVars: Record<string, string> = {};
  for (const key of variableKeys) {
    const value = valuesByKey.get(key);
    if (value === undefined) {
      return undefined;
    }
    baseUrlVars[key] = value;
  }
  return baseUrlVars;
}

export interface BuildCustomConnectorRuntimeContextArgs {
  readonly rows: CustomConnectorRuntimeDataRows;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly memberPermissionPolicies: FirewallPolicies | null;
  readonly permissionBundlesByConnectorId: ReadonlyMap<
    string,
    CustomConnectorPermissionBundle | null | undefined
  >;
}

type BuiltCustomConnectorRuntimeRow =
  | {
      readonly registration: Extract<
        ConnectorRuntimeTargetRegistration,
        { readonly kind: "custom" }
      >;
      readonly firewall: ExpandedFirewallConfig;
      readonly permissionPolicy: FirewallPolicy | undefined;
    }
  | {
      readonly registration: undefined;
      readonly firewall: undefined;
      readonly permissionPolicy: undefined;
    };

function unavailableCustomConnectorRuntimeRow(): BuiltCustomConnectorRuntimeRow {
  return {
    registration: undefined,
    firewall: undefined,
    permissionPolicy: undefined,
  };
}

export async function loadEffectiveCustomConnectorPermissionBundle(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly snapshot: ConnectorRuntimeLookup;
}): Promise<CustomConnectorPermissionBundle | null | undefined> {
  if (args.row.connector.kind === "mcp") {
    return null;
  }
  const ref = effectiveCustomConnectorPermissionBundleRef({
    slug: args.row.connector.slug,
    authMode: args.row.connector.authMode,
    oauthProviderAdapter:
      args.row.connector.oauthConfig?.providerAdapter ?? null,
    prefixTemplates: args.row.connector.prefixTemplates,
    permissionBundleRef: args.row.connector.permissionBundleRef,
  });
  return ref
    ? ((await loadCustomConnectorPermissionBundle({
        catalog: args.snapshot.serverFirewallMetadata,
        ref,
      })) ?? undefined)
    : null;
}

function buildCustomConnectorPermissionPolicy(
  bundle: CustomConnectorPermissionBundle,
): FirewallPolicy {
  return {
    policies: Object.fromEntries(
      [...bundle.permissionNames].map((permissionName) => {
        return [
          permissionName,
          bundle.defaultPolicies[permissionName] ?? "deny",
        ];
      }),
    ),
    unknownPolicy: "deny",
  };
}

function customRuntimePermissionPolicy(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly context: BuildCustomConnectorRuntimeContextArgs;
  readonly permissionBundle: CustomConnectorPermissionBundle | null;
}) {
  const { permissionBundle } = args;
  const defaultPolicy = permissionBundle
    ? buildCustomConnectorPermissionPolicy(permissionBundle)
    : undefined;
  const overlay =
    args.context.memberPermissionPolicies?.[
      customConnectorInternalName(args.row.connector.id)
    ];
  const permissionPolicy = overlay
    ? {
        policies: { ...defaultPolicy?.policies, ...overlay.policies },
        unknownPolicy:
          overlay.unknownPolicy ?? defaultPolicy?.unknownPolicy ?? "allow",
      }
    : defaultPolicy;
  return permissionPolicy;
}

function customRuntimeAuthUnavailable(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly headers: Record<string, string>;
  readonly query: Record<string, string>;
}) {
  return (
    Object.keys(args.headers).length === 0 &&
    Object.keys(args.query).length === 0 &&
    args.row.connector.kind === "mcp" &&
    args.row.connector.authMode !== "none" &&
    !(
      args.row.connector.authMode === "automatic" &&
      args.row.credentialAccess.kind === "current" &&
      args.row.credentialAccess.resolvedAuthMethod === "none"
    )
  );
}

function buildCustomConnectorRuntimeRow(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly context: BuildCustomConnectorRuntimeContextArgs;
}): BuiltCustomConnectorRuntimeRow {
  const networkEnabled = isFeatureEnabled(
    FeatureSwitchKey.CustomConnectorCloudflareAccess,
    args.context.featureSwitchContext,
  );
  const binding = args.row.connector.networkBinding;
  if (binding && (!networkEnabled || binding.status !== "available")) {
    return unavailableCustomConnectorRuntimeRow();
  }
  const baseUrlVars = resolveCustomConnectorBaseUrlVars(args.row);
  const { headers, query } = customConnectorRuntimeAuth({
    row: args.row,
  });
  if (customRuntimeAuthUnavailable({ row: args.row, headers, query })) {
    return unavailableCustomConnectorRuntimeRow();
  }
  if (baseUrlVars === undefined) {
    return unavailableCustomConnectorRuntimeRow();
  }
  const permissionBundle = args.context.permissionBundlesByConnectorId.get(
    args.row.connector.id,
  );
  if (permissionBundle === undefined) {
    return unavailableCustomConnectorRuntimeRow();
  }
  const apisResult = safeSync(() => {
    return buildCustomConnectorRuntimeApis({
      row: args.row,
      headers,
      query,
      baseUrlVars,
      permissionBundle,
    });
  });
  if ("error" in apisResult) {
    if (!(apisResult.error instanceof CustomConnectorRuntimePrefixError)) {
      throw apisResult.error;
    }
    return unavailableCustomConnectorRuntimeRow();
  }
  const networkIntent = customConnectorRuntimeNetworkIntent(
    networkEnabled,
    binding,
  );
  const apis = apisResult.ok.map((api) => {
    return {
      ...api,
      ...(networkIntent ? { networkIntent } : {}),
    };
  });
  if (apis.length === 0) {
    return unavailableCustomConnectorRuntimeRow();
  }
  const placeholders = compactRecord(
    Object.fromEntries(
      extractSecretNamesFromApis(apis).map((name) => {
        // Custom credential aliases already contain the connector UUID.
        return [name, `okou-custom-${name}`];
      }),
    ),
  );
  return {
    registration: {
      kind: "custom",
      customConnectorId: args.row.connector.id,
      baseUrlVars: { ...baseUrlVars },
      ...(args.row.credentialAccess.kind === "absent"
        ? {}
        : { sourceId: args.row.credentialAccess.memberConnectorId }),
    },
    firewall: {
      name: customConnectorInternalName(args.row.connector.id),
      description: args.row.connector.displayName,
      apis,
      ...(placeholders === undefined ? {} : { placeholders }),
    },
    permissionPolicy: customRuntimePermissionPolicy({
      ...args,
      permissionBundle,
    }),
  };
}

function customConnectorRuntimeNetworkIntent(
  enabled: boolean,
  binding: CustomConnectorExecutionDefinition["networkBinding"],
) {
  if (!enabled) {
    return undefined;
  }
  return binding?.status === "available"
    ? {
        kind: "cloudflare_access" as const,
        configId: binding.configId,
        generation: binding.generation,
      }
    : { kind: "direct" as const };
}

export function orderedCustomConnectorRuntimeRows(
  rows: BuildCustomConnectorRuntimeContextArgs["rows"],
): BuildCustomConnectorRuntimeContextArgs["rows"] {
  return orderByCustomConnectorId(rows, (row) => {
    return row.connector.id;
  });
}

export function buildCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): CustomConnectorRuntimeContext {
  const firewalls: ExpandedFirewallConfig[] = [];
  const reservedSecretAliases: Record<string, true> = {};
  const permissionPolicies: FirewallPolicies = {};
  const targets: ConnectorRuntimeTargetRegistration[] = [];
  const customConnectorIdByFirewallName: Record<string, string> = {};
  const customConnectorSourceIdByFirewallName: Record<string, string> = {};
  for (const row of orderedCustomConnectorRuntimeRows(args.rows)) {
    const built = buildCustomConnectorRuntimeRow({
      row,
      context: args,
    });
    if (!built.registration) {
      continue;
    }
    targets.push(built.registration);
    firewalls.push(built.firewall);
    customConnectorIdByFirewallName[built.firewall.name] = row.connector.id;
    if (built.registration.sourceId !== undefined) {
      customConnectorSourceIdByFirewallName[built.firewall.name] =
        built.registration.sourceId;
    }
    if (built.permissionPolicy) {
      permissionPolicies[built.firewall.name] = built.permissionPolicy;
    }
    for (const secretName of Object.keys(built.firewall.placeholders ?? {})) {
      reservedSecretAliases[secretName] = true;
    }
  }

  return {
    firewalls,
    reservedSecretAliases: compactRecord(reservedSecretAliases),
    permissionPolicies: compactRecord(permissionPolicies),
    targets,
    customConnectorIdByFirewallName,
    customConnectorSourceIdByFirewallName,
  };
}

type CustomConnectorRuntimeFirewall = Omit<
  ExecutionFirewallInlineEntry["firewall"],
  "apis"
> & {
  readonly apis: (Firewall["apis"][number] & {
    readonly id: string;
  })[];
};

interface CustomConnectorRuntimeExecutionState {
  readonly firewall: Omit<ExecutionFirewallInlineEntry, "firewall"> & {
    readonly customConnectorId: string;
    readonly firewall: CustomConnectorRuntimeFirewall;
  };
  readonly networkPolicy: NetworkPolicy;
}

export function customConnectorRuntimeExecutionState(args: {
  readonly context: CustomConnectorRuntimeContext;
  readonly connectorId: string;
}): CustomConnectorRuntimeExecutionState | null {
  const firewallName = customConnectorInternalName(args.connectorId);
  const source = args.context.firewalls.find((firewall) => {
    return firewall.name === firewallName;
  });
  if (!source) {
    return null;
  }

  const permissionNames = collectPermissionNames(source.apis);
  const defaultPolicy = allAllowPolicyForPermissions(permissionNames);
  const policy = args.context.permissionPolicies?.[firewallName];
  const networkPolicy = resolveConnectorNetworkPolicy({
    permissionNames,
    defaultPolicy,
    policy,
  });

  return {
    firewall: {
      kind: "inline",
      customConnectorId: args.connectorId,
      firewall: customConnectorRuntimeFirewall(source),
    },
    networkPolicy,
  };
}

export function collectPermissionNames(
  apis: ExpandedFirewallConfig["apis"],
): readonly string[] {
  const names = new Set<string>();
  for (const api of apis) {
    for (const permission of api.permissions ?? []) {
      names.add(permission.name);
    }
  }
  return [...names];
}

export function allAllowPolicyForPermissions(
  permissionNames: readonly string[],
): FirewallPolicy {
  return {
    policies: Object.fromEntries(
      permissionNames.map((name) => {
        return [name, "allow" as const];
      }),
    ),
    unknownPolicy: "allow",
  };
}

export function resolveConnectorNetworkPolicy(args: {
  readonly permissionNames: readonly string[];
  readonly defaultPolicy: FirewallPolicy;
  readonly policy: FirewallPolicy | undefined;
}): NetworkPolicy {
  return networkPolicyForFirewallPolicy(
    args.permissionNames,
    args.policy
      ? {
          ...args.policy,
          unknownPolicy:
            args.policy.unknownPolicy ?? args.defaultPolicy.unknownPolicy,
        }
      : args.defaultPolicy,
  );
}

export function runtimeFirewall(firewall: ExpandedFirewallConfig): Firewall {
  return {
    name: firewall.name,
    apis: firewall.apis.map((api) => {
      return {
        base: api.base,
        ...(api.hostPolicy !== undefined ? { hostPolicy: api.hostPolicy } : {}),
        auth: api.auth,
        ...(api.networkIntent ? { networkIntent: api.networkIntent } : {}),
        permissions: api.permissions ?? [],
      };
    }),
  };
}

export function customConnectorRuntimeFirewall(
  firewall: ExpandedFirewallConfig,
): CustomConnectorRuntimeFirewall {
  const runtime = runtimeFirewall(firewall);
  return {
    ...runtime,
    ...(firewall.placeholders === undefined
      ? {}
      : { placeholders: firewall.placeholders }),
    apis: runtime.apis.map((api, index) => {
      return {
        id: `${runtime.name}:${index}`,
        ...api,
      };
    }),
  };
}
