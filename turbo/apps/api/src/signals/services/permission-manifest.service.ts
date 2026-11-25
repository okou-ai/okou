import type { RunConnectorCatalogSelection } from "./thread-connected-accounts.signals";
import type {
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type { ConnectorRuntimeLookup } from "./connector-catalog-runtime.service";
import {
  allAllowPolicyForPermissions,
  collectPermissionNames,
  compactRecord,
  mergeRecords,
  customConnectorRuntimeFirewall,
  resolveConnectorNetworkPolicy,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";
import type { ConnectorServerFirewallExecutionMetadata } from "./connector-server-firewall-catalog.service";
import {
  type ConnectorSlug,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import { getModelProviderFirewall } from "@okouai/api-contracts/contracts/model-providers";
import {
  canonicalizeFirewallBaseUrlVarsForExecution,
  FirewallBaseUrlResolutionError,
  type ExecutionFirewallEntry,
  type ExecutionFirewalls,
  type ExpandedFirewallConfig,
  extractSecretNamesFromApis,
  type Firewall,
  type FirewallPolicies,
  type FirewallPolicy,
  type NetworkPolicies,
} from "@okouai/connectors/firewall-types";
import { logger } from "../../lib/log";
import { safeSync } from "../utils";

const log = logger("api:permission-manifest");

const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

function firewallSecretPlaceholdersFromFirewalls(
  firewalls: readonly ExpandedFirewallConfig[] | undefined,
): Record<string, string> | undefined {
  if (!firewalls || firewalls.length === 0) {
    return undefined;
  }

  const placeholders: Record<string, string> = {};
  for (const firewall of firewalls) {
    const secretNames = extractSecretNamesFromApis(firewall.apis);
    for (const name of secretNames) {
      placeholders[name] = DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
    }
    for (const [name, value] of Object.entries(firewall.placeholders ?? {})) {
      placeholders[name] = value;
    }
  }

  return Object.keys(placeholders).length > 0 ? placeholders : undefined;
}

function getRequiredFirewallExecutionMetadata(
  snapshot: Pick<ConnectorRuntimeLookup, "serverFirewalls">,
  connectorSlug: string,
): ConnectorServerFirewallExecutionMetadata {
  const metadata = snapshot.serverFirewalls.getExecutionMetadata(connectorSlug);
  if (!metadata) {
    throw new Error(
      `Missing connector server firewall execution metadata: ${connectorSlug}`,
    );
  }
  return metadata;
}

const BASE_URL_VAR_PATTERN = /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

const BASE_URL_VALIDATION_SECRET_TEMPLATE = [
  "$",
  "{{ secrets.__OKOU_FIREWALL_BASE_URL_VALIDATION }}",
].join("");

function builtinFirewallEntry(
  firewall: ExpandedFirewallConfig,
  vars: Record<string, string> | undefined,
): ExecutionFirewallEntry {
  const names = new Set<string>();
  for (const api of firewall.apis) {
    for (const match of api.base.matchAll(BASE_URL_VAR_PATTERN)) {
      names.add(match[1]!);
    }
  }
  if (names.size === 0) {
    return { kind: "builtin", name: firewall.name };
  }

  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [runtimeFirewall(firewall)],
    vars,
  );
  return { kind: "builtin", name: firewall.name, baseUrlVars };
}

function baseUrlValidationAuth(
  credentialed: boolean,
): Firewall["apis"][number]["auth"] {
  return credentialed
    ? {
        headers: {
          Authorization: `Bearer ${BASE_URL_VALIDATION_SECRET_TEMPLATE}`,
        },
      }
    : {};
}

function builtinFirewallEntryForMetadata(
  metadata: ConnectorServerFirewallExecutionMetadata,
  vars: Record<string, string> | undefined,
  sourceId: string,
): ExecutionFirewallEntry {
  if (metadata.baseUrlVarNames.length === 0) {
    return {
      kind: "builtin",
      name: metadata.connectorSlug,
      sourceId,
    };
  }

  const validationFirewall: Firewall = {
    name: metadata.connectorSlug,
    apis: metadata.baseUrlTemplates.map((template) => {
      return {
        base: template.base,
        ...(template.hostPolicy !== undefined
          ? { hostPolicy: template.hostPolicy }
          : {}),
        auth: baseUrlValidationAuth(template.credentialed),
        permissions: [],
      };
    }),
  };
  const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
    [validationFirewall],
    vars,
  );
  return {
    kind: "builtin",
    name: metadata.connectorSlug,
    baseUrlVars,
    sourceId,
  };
}

function customConnectorInlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
  customConnectorIdByFirewallName: Readonly<Record<string, string>>,
  customConnectorSourceIdByFirewallName: Readonly<Record<string, string>>,
): ExecutionFirewallEntry {
  const customConnectorId = customConnectorIdByFirewallName[firewall.name];
  if (!customConnectorId) {
    throw new Error("Missing Custom connector identity for inline firewall");
  }
  return {
    kind: "inline",
    customConnectorId,
    ...(customConnectorSourceIdByFirewallName[firewall.name] === undefined
      ? {}
      : { sourceId: customConnectorSourceIdByFirewallName[firewall.name] }),
    firewall: customConnectorRuntimeFirewall(firewall),
  };
}

function applyConnectorPolicies(
  connectorFirewalls: readonly ExpandedFirewallConfig[],
  policies: FirewallPolicies | undefined,
  entryForFirewall: (
    firewall: ExpandedFirewallConfig,
  ) => ExecutionFirewallEntry,
  defaultPolicyForFirewall: (
    firewall: ExpandedFirewallConfig,
    permissionNames: readonly string[],
  ) => FirewallPolicy,
): Pick<PermissionManifest, "firewalls" | "networkPolicies"> {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};

  for (const firewall of connectorFirewalls) {
    const policy = policies?.[firewall.name];
    const permissionNames = collectPermissionNames(firewall.apis);
    const defaultPolicy = defaultPolicyForFirewall(firewall, permissionNames);
    firewalls.push(entryForFirewall(firewall));

    networkPolicies[firewall.name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
  }

  return { firewalls, networkPolicies };
}

export function modelProviderPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment | null,
  vars: Record<string, string> | undefined,
): PermissionManifest | undefined {
  if (!modelProvider) {
    return undefined;
  }

  const firewall = getModelProviderFirewall(
    modelProvider.concreteType ?? modelProvider.type,
  );
  if (!firewall) {
    return undefined;
  }

  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [builtinFirewallEntry(firewall, vars)],
    environmentSecretPlaceholders: firewallSecretPlaceholdersFromFirewalls([
      firewall,
    ]),
    billableFirewalls: [],
    networkPolicies: {
      [firewall.name]: {
        allow: permissionNames.filter((name) => {
          return !denySet.has(name) && !askSet.has(name);
        }),
        deny: [...denySet],
        ask: [...askSet],
        unknownPolicy: firewall.defaultPolicies?.unknownPolicy ?? "allow",
      },
    },
  };
}

function prepareBuiltinConnectorManifest(
  selection: RunConnectorCatalogSelection,
  connectorSlugs: readonly ConnectorSlug[],
  vars: Record<string, string> | undefined,
  connectorSourceIdBySlug: Readonly<Record<string, string>>,
): Omit<PermissionManifest, "networkPolicies"> {
  const firewalls: ExecutionFirewalls = [];
  const environmentSecretPlaceholders: Record<string, string> = {};
  const billableFirewalls: string[] = [];

  for (const name of connectorSlugs) {
    if (
      selection.kind === "empty" ||
      !selection.selection.serverFirewalls.has(name)
    ) {
      continue;
    }
    const metadata = getRequiredFirewallExecutionMetadata(
      selection.selection,
      name,
    );
    const sourceId = connectorSourceIdBySlug[name];
    if (sourceId === undefined) {
      throw new Error("Missing built-in connector source identity");
    }
    const entry = safeSync(() => {
      return builtinFirewallEntryForMetadata(metadata, vars, sourceId);
    });
    if ("error" in entry) {
      if (!(entry.error instanceof FirewallBaseUrlResolutionError)) {
        throw entry.error;
      }
      log.warn("Connector excluded from Run admission", {
        connectorSlug: name,
        sourceId,
        reason: "invalid_base_url_configuration",
      });
      continue;
    }
    firewalls.push(entry.ok);
    if (!selection.selection.serverFirewalls.isMcp(name)) {
      Object.assign(environmentSecretPlaceholders, metadata.placeholderValues);
    }
    if (metadata.billable) {
      billableFirewalls.push(name);
    }
  }

  return {
    firewalls,
    environmentSecretPlaceholders: compactRecord(environmentSecretPlaceholders),
    billableFirewalls,
  };
}

function builtinRuntimeTargetRegistration(
  firewall: ExecutionFirewallEntry,
): NonNullable<PermissionManifest["builtinRuntimeTargets"]>[number] {
  if (firewall.kind !== "builtin") {
    throw new Error("Builtin connector manifest contains an inline firewall");
  }
  return {
    kind: "builtin",
    connectorSlug: connectorSlugSchema.parse(firewall.name),
    ...(firewall.baseUrlVars === undefined
      ? {}
      : { baseUrlVars: { ...firewall.baseUrlVars } }),
    ...(firewall.sourceId === undefined ? {} : { sourceId: firewall.sourceId }),
  };
}

function mergePermissionManifests(args: {
  readonly connectorManifest: Omit<PermissionManifest, "networkPolicies">;
  readonly customConnectorManifest: Pick<
    PermissionManifest,
    "firewalls" | "networkPolicies"
  >;
  readonly customConnectorFirewalls: readonly ExpandedFirewallConfig[];
}): PermissionManifest | undefined {
  const builtinRuntimeTargets = args.connectorManifest.firewalls.map(
    builtinRuntimeTargetRegistration,
  );
  const firewalls = [
    ...args.connectorManifest.firewalls,
    ...args.customConnectorManifest.firewalls,
  ];

  if (firewalls.length === 0) {
    return undefined;
  }

  return {
    firewalls,
    builtinRuntimeTargets,
    environmentSecretPlaceholders: mergeRecords(
      args.connectorManifest.environmentSecretPlaceholders,
      firewallSecretPlaceholdersFromFirewalls(args.customConnectorFirewalls),
    ),
    billableFirewalls: args.connectorManifest.billableFirewalls,
    // Builtin policies are built from captured grants at Runner publication.
    networkPolicies: args.customConnectorManifest.networkPolicies,
  };
}

interface BuildPermissionManifestArgs {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorVars?: Record<string, string>;
  readonly connectorSlugs: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug?: Readonly<Record<string, string>>;
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
  readonly customConnectorPermissionPolicies?: FirewallPolicies;
  readonly customConnectorIdByFirewallName?: Readonly<Record<string, string>>;
  readonly customConnectorSourceIdByFirewallName?: Readonly<
    Record<string, string>
  >;
  readonly timing: ApiDispatchTimingCollector;
}

export function buildConnectorPermissionManifest(
  args: BuildPermissionManifestArgs,
): PermissionManifest | undefined {
  const connectorBaseUrlVars = mergeRecords(args.vars, args.connectorVars);
  const customConnectorFirewalls = args.customConnectorFirewalls ?? [];

  const connectorManifest = args.timing.measureSync(
    "api_dispatch_prepare_context_select_builtin_targets",
    "nested",
    () => {
      return prepareBuiltinConnectorManifest(
        args.connectorCatalogSelection,
        args.connectorSlugs,
        connectorBaseUrlVars,
        args.connectorSourceIdBySlug ?? {},
      );
    },
  );

  const customConnectorManifest = args.timing.measureSync(
    "api_dispatch_prepare_context_apply_custom_permission_policies",
    "nested",
    () => {
      return applyConnectorPolicies(
        customConnectorFirewalls,
        mergeRecords(
          args.permissionPolicies,
          args.customConnectorPermissionPolicies,
        ),
        (firewall) => {
          return customConnectorInlineFirewallEntry(
            firewall,
            args.customConnectorIdByFirewallName ?? {},
            args.customConnectorSourceIdByFirewallName ?? {},
          );
        },
        (_firewall, permissionNames) => {
          return allAllowPolicyForPermissions(permissionNames);
        },
      );
    },
  );
  return args.timing.measureSync(
    "api_dispatch_prepare_context_merge_permission_manifest",
    "nested",
    () => {
      return mergePermissionManifests({
        connectorManifest,
        customConnectorManifest,
        customConnectorFirewalls,
      });
    },
  );
}
