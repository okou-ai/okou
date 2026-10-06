/** Runtime connector capability shared by launch preparation and runtime sync. */
import type { AgentCustomConnectorGrant } from "@okouai/api-contracts/contracts/agent-custom-connectors";
import { customConnectorSlugSchema } from "@okouai/api-contracts/contracts/custom-connectors";
import type { ConnectorRuntimeTargetRegistration } from "@okouai/api-contracts/contracts/runners";
import {
  type ExecutionFirewallInlineEntry,
  type ExpandedFirewallConfig,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicy,
  canonicalizeFirewallBaseUrl,
  extractSecretNamesFromApis,
  validateBaseUrlHostPolicy,
} from "@okouai/connectors/firewall-types";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { safeSync } from "../utils";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import type { CustomConnectorCredentialAccess } from "./custom-connector-credential-access.service";
import { orderByCustomConnectorId } from "./custom-connector-order";
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
  readonly mcpConnectorSlugs: readonly string[];
  readonly skills: readonly {
    readonly connectorId: string;
    readonly connectorSlug: string;
    readonly versionId: string;
  }[];
}

export function compactRecord<T>(
  values: Record<string, T>,
): Record<string, T> | undefined {
  return Object.keys(values).length > 0 ? values : undefined;
}

export type CustomConnectorRuntimeDataRows = readonly {
  readonly connector: CustomConnectorExecutionDefinition;
  readonly values: readonly CustomConnectorStoredValueRow[];
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
    const endpointResult = safeSync(() => {
      const canonicalEndpoint = canonicalizeFirewallBaseUrl(
        connector.endpoint,
        "MCP custom connector",
      );
      const endpoint = new URL(canonicalEndpoint);
      if (endpoint.protocol !== "https:") {
        throw new Error("MCP endpoint must use https://");
      }
      validateBaseUrlHostPolicy({
        base: canonicalEndpoint,
        serviceName: "MCP custom connector",
        hostPolicy: { kind: "publicDestination" },
      });
      return canonicalEndpoint;
    });
    if ("error" in endpointResult) {
      return [];
    }
    const endpoint = endpointResult.ok;
    return [
      {
        base: endpoint,
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

export function resolveCustomConnectorBaseUrlVars(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly provided: Readonly<Record<string, string>> | undefined;
  readonly hasProvided: boolean;
}): Readonly<Record<string, string>> | undefined {
  if (args.row.connector.kind === "mcp") {
    if (!args.hasProvided) {
      return {};
    }
    return Object.keys(args.provided ?? {}).length === 0 ? {} : undefined;
  }
  const variableKeys = [
    ...customConnectorPrefixTemplateVariableKeys(
      args.row.connector.prefixTemplates,
    ),
  ].sort();
  if (args.hasProvided) {
    const provided = args.provided ?? {};
    const providedKeys = Object.keys(provided).sort();
    return jsonArrayEqual(variableKeys, providedKeys)
      ? { ...provided }
      : undefined;
  }
  if (variableKeys.length === 0) {
    return {};
  }
  const prefixValues = args.row.values.filter(
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

function jsonArrayEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      return value === right[index];
    })
  );
}

export interface BuildCustomConnectorRuntimeContextArgs {
  readonly rows: CustomConnectorRuntimeDataRows;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly connectorCatalogSnapshot: ConnectorRuntimeSelection;
  readonly grants: readonly AgentCustomConnectorGrant[] | undefined;
  readonly permissionBundlesByConnectorId?: ReadonlyMap<
    string,
    CustomConnectorPermissionBundle | null | undefined
  >;
  readonly baseUrlVarsByConnectorId?: ReadonlyMap<
    string,
    Readonly<Record<string, string>>
  >;
}

type BuiltCustomConnectorRuntimeRow =
  | {
      readonly registration: Extract<
        ConnectorRuntimeTargetRegistration,
        { readonly kind: "custom" }
      >;
      readonly skill:
        | CustomConnectorRuntimeContext["skills"][number]
        | undefined;
      readonly firewall: ExpandedFirewallConfig;
      readonly permissionPolicy: FirewallPolicy | undefined;
    }
  | {
      readonly registration: undefined;
      readonly skill:
        | CustomConnectorRuntimeContext["skills"][number]
        | undefined;
      readonly firewall: undefined;
      readonly permissionPolicy: undefined;
    };

export function customConnectorRuntimeSkill(
  row: CustomConnectorRuntimeDataRows[number],
): CustomConnectorRuntimeContext["skills"][number] | undefined {
  const { skillStorageVersionId } = row.connector;
  if (skillStorageVersionId === null) {
    return undefined;
  }
  return {
    connectorId: row.connector.id,
    connectorSlug: row.connector.slug,
    versionId: skillStorageVersionId,
  };
}

function unavailableCustomConnectorRuntimeRow(
  skill: BuiltCustomConnectorRuntimeRow["skill"],
): BuiltCustomConnectorRuntimeRow {
  return {
    registration: undefined,
    skill,
    firewall: undefined,
    permissionPolicy: undefined,
  };
}

export async function loadEffectiveCustomConnectorPermissionBundle(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly snapshot: ConnectorRuntimeSelection;
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

function buildCustomConnectorPermissionPolicy(args: {
  readonly bundle: CustomConnectorPermissionBundle;
  readonly selectedPermissionNames: readonly string[];
}): FirewallPolicy {
  const selectedPermissionNames = new Set(args.selectedPermissionNames);
  return {
    policies: Object.fromEntries(
      [...args.bundle.permissionNames].map((permissionName) => {
        return [
          permissionName,
          selectedPermissionNames.has(permissionName)
            ? "allow"
            : (args.bundle.defaultPolicies[permissionName] ?? "deny"),
        ];
      }),
    ),
    unknownPolicy: "deny",
  };
}

async function buildCustomConnectorRuntimeRow(args: {
  readonly row: CustomConnectorRuntimeDataRows[number];
  readonly context: BuildCustomConnectorRuntimeContextArgs;
  readonly selectedPermissionNames: readonly string[];
}): Promise<BuiltCustomConnectorRuntimeRow> {
  const hasProvidedBaseUrlVars =
    args.context.baseUrlVarsByConnectorId?.has(args.row.connector.id) ?? false;
  const baseUrlVars = resolveCustomConnectorBaseUrlVars({
    row: args.row,
    provided: args.context.baseUrlVarsByConnectorId?.get(args.row.connector.id),
    hasProvided: hasProvidedBaseUrlVars,
  });
  const skill = customConnectorRuntimeSkill(args.row);
  const { headers, query } = customConnectorRuntimeAuth({
    row: args.row,
  });
  if (Object.keys(headers).length === 0 && Object.keys(query).length === 0) {
    if (
      args.row.connector.kind === "mcp" &&
      args.row.connector.authMode !== "none" &&
      !(
        args.row.connector.authMode === "automatic" &&
        args.row.credentialAccess.kind === "current" &&
        args.row.credentialAccess.resolvedAuthMethod === "none"
      )
    ) {
      return unavailableCustomConnectorRuntimeRow(skill);
    }
  }
  if (baseUrlVars === undefined) {
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  const permissionBundle = args.context.permissionBundlesByConnectorId
    ? args.context.permissionBundlesByConnectorId.get(args.row.connector.id)
    : await loadEffectiveCustomConnectorPermissionBundle({
        row: args.row,
        snapshot: args.context.connectorCatalogSnapshot,
      });
  if (permissionBundle === undefined) {
    return unavailableCustomConnectorRuntimeRow(skill);
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
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  const apis = apisResult.ok;
  if (apis.length === 0) {
    return unavailableCustomConnectorRuntimeRow(skill);
  }
  return {
    registration: {
      kind: "custom",
      customConnectorId: args.row.connector.id,
      baseUrlVars: { ...baseUrlVars },
      ...(args.row.credentialAccess.kind === "absent"
        ? {}
        : { sourceId: args.row.credentialAccess.memberConnectorId }),
    },
    skill,
    firewall: {
      name: customConnectorInternalName(args.row.connector.id),
      description: args.row.connector.displayName,
      apis,
    },
    permissionPolicy: permissionBundle
      ? buildCustomConnectorPermissionPolicy({
          bundle: permissionBundle,
          selectedPermissionNames: args.selectedPermissionNames,
        })
      : undefined,
  };
}

export function orderedCustomConnectorRuntimeRows(
  rows: BuildCustomConnectorRuntimeContextArgs["rows"],
): BuildCustomConnectorRuntimeContextArgs["rows"] {
  return orderByCustomConnectorId(rows, (row) => {
    return row.connector.id;
  });
}

export async function buildCustomConnectorRuntimeContext(
  args: BuildCustomConnectorRuntimeContextArgs,
): Promise<CustomConnectorRuntimeContext> {
  const firewalls: ExpandedFirewallConfig[] = [];
  const reservedSecretAliases: Record<string, true> = {};
  const permissionPolicies: FirewallPolicies = {};
  const targets: ConnectorRuntimeTargetRegistration[] = [];
  const customConnectorIdByFirewallName: Record<string, string> = {};
  const customConnectorSourceIdByFirewallName: Record<string, string> = {};
  const mcpConnectorSlugs: string[] = [];
  const skills: {
    connectorId: string;
    connectorSlug: string;
    versionId: string;
  }[] = [];
  const grantByConnectorId = new Map(
    (args.grants ?? []).map((grant) => {
      return [grant.customConnectorId, grant.permissionNames] as const;
    }),
  );
  for (const row of orderedCustomConnectorRuntimeRows(args.rows)) {
    const built = await buildCustomConnectorRuntimeRow({
      row,
      context: args,
      selectedPermissionNames: grantByConnectorId.get(row.connector.id) ?? [],
    });
    if (built.skill) {
      skills.push(built.skill);
    }
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
    if (row.connector.kind === "mcp") {
      const slug = customConnectorSlugSchema.safeParse(row.connector.slug);
      if (slug.success) {
        mcpConnectorSlugs.push(slug.data);
      }
    }
    if (built.permissionPolicy) {
      permissionPolicies[built.firewall.name] = built.permissionPolicy;
    }
    for (const secretName of extractSecretNamesFromApis(built.firewall.apis)) {
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
    mcpConnectorSlugs,
    skills,
  };
}

type CustomConnectorRuntimeFirewall = Omit<Firewall, "apis"> & {
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
    apis: runtime.apis.map((api, index) => {
      return {
        id: `${runtime.name}:${index}`,
        ...api,
      };
    }),
  };
}
