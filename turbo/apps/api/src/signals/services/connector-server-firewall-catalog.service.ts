import { isDeepStrictEqual } from "node:util";

import type { ConnectorSlug } from "@okouai/api-contracts/contracts/connector-identity";
import {
  connectorAuthMethodRuntimeMetadata,
  type ConnectorRuntimeBindingEntry,
} from "@okouai/connectors/connector-auth-method";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import type { FirewallPermissionPolicyDefaultMetadata } from "@okouai/connectors/firewall-metadata/policy";
import {
  extractSecretNamesFromApis,
  normalizeFirewallFixedHost,
  UNKNOWN_PERMISSION_GRANT,
  type FirewallBaseHostPolicy,
  type FirewallPolicies,
  type FirewallPolicyValue,
} from "@okouai/connectors/firewall-types";

import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  connectorCatalogFirewallConfig,
  deriveConnectorCatalogFirewallPermissions,
  deriveConnectorCatalogFirewallRouting,
  type ConnectorCatalogFirewallRouting,
} from "@okouai/connectors/connector-catalog/artifacts/relationships";

const POLICY_VALUES = ["allow", "deny", "ask"] as const;
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

type AcceptedFirewallConfig = NonNullable<
  ReturnType<typeof connectorCatalogFirewallConfig>
>;
type AcceptedGeneratedFirewall = Extract<
  ConnectorCatalogArtifactConnector["firewall"],
  { readonly kind: "generated" }
>;

interface AcceptedServerFirewall {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly billable: boolean;
  readonly firewall: AcceptedFirewallConfig;
  readonly defaultAllowed: AcceptedGeneratedFirewall["defaultAllowed"];
  readonly defaultUnknownPolicy: AcceptedGeneratedFirewall["defaultUnknownPolicy"];
}

export interface ConnectorServerFirewallPermissionIndex {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly permissionNames: ReadonlySet<string>;
  readonly permissionDescriptions: ReadonlyMap<string, string>;
  readonly defaultPermissionPolicies: Readonly<
    Record<string, FirewallPolicyValue>
  >;
  readonly defaultPolicy: FirewallPermissionPolicyDefaultMetadata;
  hasPermission(name: string): boolean;
  permissionDescription(name: string): string | null;
}

export interface ConnectorServerFirewallExecutionBaseUrlTemplate {
  readonly base: string;
  readonly credentialed: boolean;
  readonly hostPolicy?: FirewallBaseHostPolicy;
}

export interface ConnectorServerFirewallExecutionMetadata {
  readonly connectorSlug: ConnectorSlug;
  readonly billable: boolean;
  readonly baseUrlVarNames: readonly string[];
  readonly baseUrlTemplates: readonly ConnectorServerFirewallExecutionBaseUrlTemplate[];
  readonly secretPlaceholderNames: readonly string[];
  readonly placeholderValues: Readonly<Record<string, string>>;
}

export interface ConnectorServerFirewallRoutingIndexMetadata {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly apis: readonly FirewallRoutingIndexApiMetadata[];
}

export interface ConnectorServerFirewallRoutingMetadata {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
  readonly apis: readonly FirewallRoutingApiMetadata[];
}

export interface ConnectorServerFirewallHostOwner {
  readonly connectorSlug: ConnectorSlug;
  readonly label: string;
}

export interface ConnectorServerFirewallMetadataCatalog {
  has(connectorSlug: string): boolean;
  loadPermissionIndex(
    connectorSlug: string,
  ): Promise<ConnectorServerFirewallPermissionIndex | null>;
  getRoutingIndexMetadata(
    connectorSlug: string,
  ): ConnectorServerFirewallRoutingIndexMetadata | null;
  loadRoutingMetadata(
    connectorSlug: string,
  ): Promise<ConnectorServerFirewallRoutingMetadata | null>;
}

export interface ConnectorServerFirewallSelection extends ConnectorServerFirewallMetadataCatalog {
  getExecutionMetadata(
    connectorSlug: string,
  ): ConnectorServerFirewallExecutionMetadata | null;
}

export interface ConnectorServerFirewallCatalog extends ConnectorServerFirewallSelection {
  readonly connectorSlugs: readonly ConnectorSlug[];
  getFixedHostOwner(host: string): ConnectorServerFirewallHostOwner | null;
}

interface AcceptedConnectorServerFirewallEntry {
  readonly connector: ConnectorCatalogArtifactConnector;
  readonly runtimeMethods: () => readonly ConnectorAuthMethodRuntimeConfig[];
  firewall: AcceptedServerFirewall | undefined;
  routing: ConnectorCatalogFirewallRouting | undefined;
  permissionIndex: ConnectorServerFirewallPermissionIndex | undefined;
  executionMetadata: ConnectorServerFirewallExecutionMetadata | undefined;
  routingIndexMetadata: ConnectorServerFirewallRoutingIndexMetadata | undefined;
  routingMetadata: ConnectorServerFirewallRoutingMetadata | undefined;
}

export interface FirewallRoutingRouteMetadata {
  readonly permissionName: string;
  readonly rule: string;
}

interface FirewallRoutingIndexApiMetadata {
  readonly base: string;
}

interface FirewallRoutingApiMetadata {
  readonly base: string;
  readonly environmentNames: readonly string[];
  readonly routes: readonly FirewallRoutingRouteMetadata[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedStringRecord(
  entries: Iterable<readonly [string, string]>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => {
      return compareStrings(left, right);
    }),
  );
}

function choosePermissionDefault(
  policies: Readonly<Record<string, FirewallPolicyValue>>,
): FirewallPolicyValue {
  const counts = new Map<FirewallPolicyValue, number>(
    POLICY_VALUES.map((value) => {
      return [value, 0];
    }),
  );
  for (const value of Object.values(policies)) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return POLICY_VALUES.reduce<FirewallPolicyValue>((best, candidate) => {
    return (counts.get(candidate) ?? 0) > (counts.get(best) ?? 0)
      ? candidate
      : best;
  }, "allow");
}

function compactDefaultPolicy(args: {
  readonly policies: Readonly<Record<string, FirewallPolicyValue>>;
  readonly defaultUnknownPolicy: FirewallPolicyValue;
}): FirewallPermissionPolicyDefaultMetadata {
  const permissionDefault = choosePermissionDefault(args.policies);
  const permissionOverrides: Partial<
    Record<FirewallPolicyValue, readonly string[]>
  > = {};
  for (const value of POLICY_VALUES) {
    if (value === permissionDefault) {
      continue;
    }
    const permissions = Object.entries(args.policies)
      .filter(([, policy]) => {
        return policy === value;
      })
      .map(([permission]) => {
        return permission;
      })
      .sort(compareStrings);
    if (permissions.length > 0) {
      permissionOverrides[value] = permissions;
    }
  }
  return {
    permissionDefault,
    ...(Object.keys(permissionOverrides).length > 0
      ? { permissionOverrides }
      : {}),
    unknownPolicy: args.defaultUnknownPolicy,
  };
}

function acceptedPermissionIndex(
  firewall: AcceptedServerFirewall,
): ConnectorServerFirewallPermissionIndex {
  const permissions = new Map(
    deriveConnectorCatalogFirewallPermissions(firewall.firewall.apis).map(
      (permission) => {
        return [permission.name, permission.description] as const;
      },
    ),
  );
  permissions.delete(UNKNOWN_PERMISSION_GRANT);
  const permissionNames = [...permissions.keys()].sort(compareStrings);
  const allowed = firewall.defaultAllowed
    ? new Set<string>(firewall.defaultAllowed)
    : null;
  const defaultPermissionPolicies = Object.fromEntries(
    permissionNames.map((permission): [string, FirewallPolicyValue] => {
      return [
        permission,
        allowed === null || allowed.has(permission) ? "allow" : "deny",
      ];
    }),
  );
  const defaultPolicy = compactDefaultPolicy({
    policies: defaultPermissionPolicies,
    defaultUnknownPolicy: firewall.defaultUnknownPolicy,
  });
  const permissionDescriptions = new Map<string, string>();
  for (const [name, description] of permissions) {
    if (description !== undefined) {
      permissionDescriptions.set(name, description);
    }
  }
  const permissionNameSet = new Set(permissionNames);
  return {
    connectorSlug: firewall.connectorSlug,
    label: firewall.label,
    permissionNames: permissionNameSet,
    permissionDescriptions,
    defaultPermissionPolicies,
    defaultPolicy,
    hasPermission: (name) => {
      return permissionNameSet.has(name);
    },
    permissionDescription: (name) => {
      return permissionDescriptions.get(name) ?? null;
    },
  };
}

function runtimeBindingEntries(
  methods: readonly ConnectorAuthMethodRuntimeConfig[],
): readonly ConnectorRuntimeBindingEntry[] {
  return methods.flatMap((method) => {
    return connectorAuthMethodRuntimeMetadata(method).runtimeBindings;
  });
}

function expandedAcceptedPlaceholders(args: {
  readonly firewall: AcceptedServerFirewall["firewall"];
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): Readonly<Record<string, string>> {
  const expanded: Record<string, string> = {
    ...args.firewall.placeholders,
  };
  const bindings = runtimeBindingEntries(args.methods);
  for (const [name, value] of Object.entries(
    args.firewall.placeholders ?? {},
  )) {
    const bindingValueRefs = bindings
      .filter((binding) => {
        return binding.envName === name;
      })
      .map((binding) => {
        return binding.valueRef;
      });
    for (const valueRef of bindingValueRefs) {
      if (!valueRef.startsWith("$secrets.")) {
        continue;
      }
      const rawName = valueRef.slice("$secrets.".length);
      if (!expanded[rawName]) {
        expanded[rawName] = value;
      }
      for (const binding of bindings) {
        if (binding.valueRef === valueRef && !expanded[binding.envName]) {
          expanded[binding.envName] = value;
        }
      }
    }
    const rawValueRef = `$secrets.${name}`;
    for (const binding of bindings) {
      if (binding.valueRef === rawValueRef && !expanded[binding.envName]) {
        expanded[binding.envName] = value;
      }
    }
  }
  return expanded;
}

function acceptedPlaceholderValues(args: {
  readonly firewall: AcceptedServerFirewall["firewall"];
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): Readonly<Record<string, string>> {
  const expanded = expandedAcceptedPlaceholders(args);
  const placeholderValues: Record<string, string> = {};
  for (const name of extractSecretNamesFromApis(args.firewall.apis)) {
    placeholderValues[name] =
      expanded[name] ?? DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
  }
  for (const [name, value] of Object.entries(expanded)) {
    placeholderValues[name] = value;
  }
  return sortedStringRecord(Object.entries(placeholderValues));
}

function acceptedBaseUrlTemplates(args: {
  readonly firewall: AcceptedServerFirewall;
  readonly routing: ConnectorCatalogFirewallRouting;
}): readonly ConnectorServerFirewallExecutionBaseUrlTemplate[] {
  const templates = new Map<
    string,
    ConnectorServerFirewallExecutionBaseUrlTemplate
  >();
  for (const template of args.routing.baseUrlTemplates) {
    const existing = templates.get(template.base);
    if (
      existing &&
      !isDeepStrictEqual(existing.hostPolicy, template.hostPolicy)
    ) {
      throw new Error(
        `Accepted connector server firewall base URL host policies conflict: ${args.firewall.connectorSlug} (${template.base})`,
      );
    }
    templates.set(template.base, {
      base: template.base,
      credentialed: (existing?.credentialed ?? false) || template.credentialed,
      ...(template.hostPolicy === undefined
        ? {}
        : { hostPolicy: template.hostPolicy }),
    });
  }
  return [...templates.values()].sort((left, right) => {
    return compareStrings(left.base, right.base);
  });
}

function acceptedExecutionMetadata(args: {
  readonly firewall: AcceptedServerFirewall;
  readonly routing: ConnectorCatalogFirewallRouting;
  readonly methods: readonly ConnectorAuthMethodRuntimeConfig[];
}): ConnectorServerFirewallExecutionMetadata {
  const placeholderValues = acceptedPlaceholderValues({
    firewall: args.firewall.firewall,
    methods: args.methods,
  });
  return {
    connectorSlug: args.firewall.connectorSlug,
    billable: args.firewall.billable,
    baseUrlVarNames: args.routing.baseUrlVarNames,
    baseUrlTemplates: acceptedBaseUrlTemplates({
      firewall: args.firewall,
      routing: args.routing,
    }),
    secretPlaceholderNames: Object.keys(placeholderValues),
    placeholderValues,
  };
}

function acceptedRoutingIndexMetadata(args: {
  readonly firewall: AcceptedServerFirewall;
  readonly routing: ConnectorCatalogFirewallRouting;
}): ConnectorServerFirewallRoutingIndexMetadata {
  return {
    connectorSlug: args.firewall.connectorSlug,
    label: args.firewall.label,
    apis: args.routing.apis.map((api) => {
      return { base: api.base };
    }),
  };
}

function acceptedRoutingMetadata(args: {
  readonly firewall: AcceptedServerFirewall;
  readonly routing: ConnectorCatalogFirewallRouting;
}): ConnectorServerFirewallRoutingMetadata {
  return {
    connectorSlug: args.firewall.connectorSlug,
    label: args.firewall.label,
    apis: args.routing.apis.map((api) => {
      return {
        base: api.base,
        environmentNames: api.environmentNames,
        routes: api.routes,
      };
    }),
  };
}

function acceptedEntries(args: {
  readonly connectors: readonly ConnectorCatalogArtifactConnector[];
  readonly runtimeMethodsForSlug: (
    connectorSlug: ConnectorSlug,
  ) => readonly ConnectorAuthMethodRuntimeConfig[];
}): ReadonlyMap<ConnectorSlug, AcceptedConnectorServerFirewallEntry> {
  const entries = new Map<
    ConnectorSlug,
    AcceptedConnectorServerFirewallEntry
  >();
  for (const connector of args.connectors) {
    if (connector.firewall.kind === "none") {
      continue;
    }
    if (entries.has(connector.slug)) {
      throw new Error(
        `Duplicate accepted connector server firewall: ${connector.slug}`,
      );
    }
    entries.set(connector.slug, {
      connector,
      runtimeMethods: () => {
        return args.runtimeMethodsForSlug(connector.slug);
      },
      firewall: undefined,
      routing: undefined,
      permissionIndex: undefined,
      executionMetadata: undefined,
      routingIndexMetadata: undefined,
      routingMetadata: undefined,
    });
  }
  return entries;
}

function acceptedEntryFirewall(
  entry: AcceptedConnectorServerFirewallEntry,
): AcceptedServerFirewall {
  if (entry.firewall !== undefined) {
    return entry.firewall;
  }
  const connector = entry.connector;
  const firewall = connectorCatalogFirewallConfig(connector);
  if (firewall === null || connector.firewall.kind === "none") {
    throw new Error(
      `Accepted connector server firewall is missing: ${connector.slug}`,
    );
  }
  const accepted = {
    connectorSlug: connector.slug,
    label: connector.label,
    billable: connector.firewall.billable,
    firewall,
    defaultAllowed: connector.firewall.defaultAllowed,
    defaultUnknownPolicy: connector.firewall.defaultUnknownPolicy,
  };
  entry.firewall = accepted;
  return accepted;
}

function acceptedEntryRouting(
  entry: AcceptedConnectorServerFirewallEntry,
): ConnectorCatalogFirewallRouting {
  if (entry.routing !== undefined) {
    return entry.routing;
  }
  const routing = deriveConnectorCatalogFirewallRouting(
    acceptedEntryFirewall(entry).firewall,
  );
  entry.routing = routing;
  return routing;
}

function acceptedEntryPermissionIndex(
  entry: AcceptedConnectorServerFirewallEntry,
): ConnectorServerFirewallPermissionIndex {
  if (entry.permissionIndex !== undefined) {
    return entry.permissionIndex;
  }
  const permissionIndex = acceptedPermissionIndex(acceptedEntryFirewall(entry));
  entry.permissionIndex = permissionIndex;
  return permissionIndex;
}

function acceptedEntryExecutionMetadata(
  entry: AcceptedConnectorServerFirewallEntry,
): ConnectorServerFirewallExecutionMetadata {
  if (entry.executionMetadata !== undefined) {
    return entry.executionMetadata;
  }
  const executionMetadata = acceptedExecutionMetadata({
    firewall: acceptedEntryFirewall(entry),
    routing: acceptedEntryRouting(entry),
    methods: entry.runtimeMethods(),
  });
  entry.executionMetadata = executionMetadata;
  return executionMetadata;
}

function acceptedEntryRoutingIndexMetadata(
  entry: AcceptedConnectorServerFirewallEntry,
): ConnectorServerFirewallRoutingIndexMetadata {
  if (entry.routingIndexMetadata !== undefined) {
    return entry.routingIndexMetadata;
  }
  const routingIndexMetadata = acceptedRoutingIndexMetadata({
    firewall: acceptedEntryFirewall(entry),
    routing: acceptedEntryRouting(entry),
  });
  entry.routingIndexMetadata = routingIndexMetadata;
  return routingIndexMetadata;
}

function acceptedEntryRoutingMetadata(
  entry: AcceptedConnectorServerFirewallEntry,
): ConnectorServerFirewallRoutingMetadata {
  if (entry.routingMetadata !== undefined) {
    return entry.routingMetadata;
  }
  const routingMetadata = acceptedRoutingMetadata({
    firewall: acceptedEntryFirewall(entry),
    routing: acceptedEntryRouting(entry),
  });
  entry.routingMetadata = routingMetadata;
  return routingMetadata;
}

function acceptedFixedHostOwners(
  entries: Iterable<AcceptedConnectorServerFirewallEntry>,
): ReadonlyMap<string, ConnectorServerFirewallHostOwner> {
  const owners = new Map<string, ConnectorServerFirewallHostOwner>();
  for (const entry of entries) {
    const firewall = acceptedEntryFirewall(entry);
    const routing = acceptedEntryRouting(entry);
    for (const rawHost of routing.fixedHosts) {
      const host = normalizeFirewallFixedHost(rawHost);
      if (!host) {
        throw new Error(
          `Accepted connector server firewall fixed host is invalid: ${firewall.connectorSlug}`,
        );
      }
      const existing = owners.get(host);
      if (
        existing &&
        compareStrings(existing.connectorSlug, firewall.connectorSlug) <= 0
      ) {
        continue;
      }
      owners.set(host, {
        connectorSlug: firewall.connectorSlug,
        label: firewall.label,
      });
    }
  }
  return owners;
}

export function createAcceptedConnectorServerFirewallCatalog(args: {
  readonly artifact: ConnectorCatalogArtifact;
  readonly runtimeMethodsForSlug: (
    connectorSlug: ConnectorSlug,
  ) => readonly ConnectorAuthMethodRuntimeConfig[];
}): ConnectorServerFirewallCatalog {
  return createAcceptedConnectorServerFirewallCatalogFromConnectors({
    connectors: args.artifact.connectors,
    runtimeMethodsForSlug: args.runtimeMethodsForSlug,
  });
}

export function createAcceptedConnectorServerFirewallCatalogFromConnectors(args: {
  readonly connectors: readonly ConnectorCatalogArtifactConnector[];
  readonly runtimeMethodsForSlug: (
    connectorSlug: ConnectorSlug,
  ) => readonly ConnectorAuthMethodRuntimeConfig[];
}): ConnectorServerFirewallCatalog {
  const entries = acceptedEntries({
    connectors: args.connectors,
    runtimeMethodsForSlug: args.runtimeMethodsForSlug,
  });
  const connectorSlugs = [...entries.keys()].sort(compareStrings);
  let fixedHostOwners:
    | ReadonlyMap<string, ConnectorServerFirewallHostOwner>
    | undefined;
  return {
    connectorSlugs,
    has: (connectorSlug) => {
      return entries.has(connectorSlug);
    },
    getExecutionMetadata: (connectorSlug) => {
      const entry = entries.get(connectorSlug);
      return entry ? acceptedEntryExecutionMetadata(entry) : null;
    },
    loadPermissionIndex: (connectorSlug) => {
      const entry = entries.get(connectorSlug);
      return Promise.resolve(
        entry ? acceptedEntryPermissionIndex(entry) : null,
      );
    },
    getRoutingIndexMetadata: (connectorSlug) => {
      const entry = entries.get(connectorSlug);
      return entry ? acceptedEntryRoutingIndexMetadata(entry) : null;
    },
    loadRoutingMetadata: (connectorSlug) => {
      const entry = entries.get(connectorSlug);
      return Promise.resolve(
        entry ? acceptedEntryRoutingMetadata(entry) : null,
      );
    },
    getFixedHostOwner: (host) => {
      const normalized = normalizeFirewallFixedHost(host);
      if (!normalized) {
        return null;
      }
      fixedHostOwners ??= acceptedFixedHostOwners(entries.values());
      return fixedHostOwners.get(normalized) ?? null;
    },
  };
}

export function selectConnectorServerFirewalls(args: {
  readonly catalog: ConnectorServerFirewallCatalog;
  readonly connectorSlugs: readonly ConnectorSlug[];
}): ConnectorServerFirewallSelection {
  const selectedConnectorSlugs = new Set<string>(args.connectorSlugs);
  const selectedEntryExists = (connectorSlug: string): boolean => {
    return (
      selectedConnectorSlugs.has(connectorSlug) &&
      args.catalog.has(connectorSlug)
    );
  };
  return {
    has: selectedEntryExists,
    getExecutionMetadata: (connectorSlug) => {
      return selectedEntryExists(connectorSlug)
        ? args.catalog.getExecutionMetadata(connectorSlug)
        : null;
    },
    loadPermissionIndex: (connectorSlug) => {
      return selectedEntryExists(connectorSlug)
        ? args.catalog.loadPermissionIndex(connectorSlug)
        : Promise.resolve(null);
    },
    getRoutingIndexMetadata: (connectorSlug) => {
      return selectedEntryExists(connectorSlug)
        ? args.catalog.getRoutingIndexMetadata(connectorSlug)
        : null;
    },
    loadRoutingMetadata: (connectorSlug) => {
      return selectedEntryExists(connectorSlug)
        ? args.catalog.loadRoutingMetadata(connectorSlug)
        : Promise.resolve(null);
    },
  };
}

export async function expandConnectorServerFirewallPolicies(args: {
  readonly catalog: ConnectorServerFirewallMetadataCatalog;
  readonly stored: FirewallPolicies | null;
  readonly connectorSlugs: readonly string[];
}): Promise<FirewallPolicies | null> {
  const indexes = await Promise.all(
    args.connectorSlugs.map((connectorSlug) => {
      return args.catalog.loadPermissionIndex(connectorSlug);
    }),
  );
  let resolved: FirewallPolicies | null = null;
  for (const index of indexes) {
    if (!index) {
      continue;
    }
    resolved ??= { ...args.stored };
    const existing = resolved[index.connectorSlug];
    resolved[index.connectorSlug] = {
      policies: {
        ...index.defaultPermissionPolicies,
        ...existing?.policies,
      },
      ...(existing?.unknownPolicy !== undefined
        ? { unknownPolicy: existing.unknownPolicy }
        : { unknownPolicy: index.defaultPolicy.unknownPolicy }),
    };
  }
  return resolved ?? args.stored;
}
