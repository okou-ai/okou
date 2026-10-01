/**
 * Runner payload assembly shared by execution owners: stored execution context
 * draft and secrets, permission manifest, runner storage input and the
 * finalized materialized launch. Moved verbatim out of the legacy execution
 * graph.
 */
import { settle } from "../utils";
import { badRequestMessage } from "../../lib/error";
import { nowDate } from "../../lib/time";
import type { Db } from "../external/db";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import {
  type FeatureSwitchContext,
  getAllFeatureStates,
} from "@okouai/core/feature-switch";
import type { SupportedFramework } from "@okouai/core/frameworks";
import type { PersistedStorageMount } from "@okouai/db/types";
import { env, optionalEnv } from "../../lib/env";
import {
  expandVariablesInString,
  expandVariables,
} from "@okouai/core/variable-expander";
import {
  type PiModelConfig,
  type PiMemoryRecallSelection,
  type StoredExecutionContext,
  type SecretConnectorMetadata,
  type StoredConnectorPermissionBaseline,
  type ConnectorRuntimeTargetRegistration,
  PI_MEMORY_ROOT,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  type PiInstalledCliRequirement,
  DEFAULT_PROFILE,
} from "@okouai/api-contracts/contracts/runners";
import type { AgentRunFullLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import {
  isBuiltInModelProviderType,
  getModelProviderFirewall,
} from "@okouai/api-contracts/contracts/model-providers";
import type { AgentExecutionConfig as agentRunCreateAgentExecutionConfig } from "./agent-execution-config";
import {
  type ExpandedFirewallConfig,
  type ExecutionFirewalls,
  type NetworkPolicies,
  FirewallBaseUrlResolutionError,
  type FirewallPolicies,
  type ExecutionFirewallEntry,
  type Firewall,
  canonicalizeFirewallBaseUrlVarsForExecution,
  type FirewallPolicy,
  extractSecretNamesFromApis,
} from "@okouai/connectors/firewall-types";
import {
  type ConnectorSlug,
  connectorSlugSchema,
} from "@okouai/api-contracts/contracts/connector-identity";
import {
  type RunContextAxiomSnapshot,
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  networkPoliciesRecordToEntries,
  featureFlagsRecordToEntries,
} from "./run-context-snapshot.service";
import { generateOkouToken } from "../auth/tokens";
import {
  DISABLED_PAID_TOOLS_ENV_VAR,
  ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR,
} from "@okouai/api-contracts/contracts/paid-tools";
import {
  resolvePiLangfuseDebugConfig,
  piLangfuseDebugPlatformEnvironment,
} from "../../lib/pi-langfuse-debug";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  type PiExecutionRoute,
  normalizePiExecutionRoute,
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import type { ConnectorRuntimeSelection } from "./connector-catalog-runtime.service";
import type {
  ConnectorServerFirewallExecutionMetadata,
  ConnectorServerFirewallPermissionIndex,
} from "./connector-server-firewall-catalog.service";
import { defaultFirewallPolicyForPermissionIndex } from "./firewall-network-policy.service";
import { currentConnectorCatalogValidatorIdentity } from "./connector-catalog-validator-authority";
import {
  type CustomConnectorRuntimeContext,
  compactRecord,
  allAllowPolicyForPermissions,
  resolveConnectorNetworkPolicy,
  collectPermissionNames,
  customConnectorRuntimeFirewall,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";
import {
  AdditionalVolumeSources,
  AgentRunCreateAdditionalVolume,
  AgentRunCreateContextArtifact,
  ArtifactMissingRootPolicy,
  BuiltinConnectorRuntimeContext,
  BuiltinRuntimeTargetRegistration,
  CreateAgentRunArgs,
  CreateRunBody,
  CreateRunErrorResult,
  FinalizedPreparedRunContext,
  PermissionManifest,
  PreparedRunnerLaunch,
  ResolvedModelProviderEnvironment,
  ResolvedRunExecution,
  RunRecord,
  firstAgent,
  runnerGroup,
  runnerJobPayload,
  runnerReuseKey,
} from "./execution-launch-persistence.service";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  MaterializedAgentRunStorage,
  PreparedAgentRunStorage,
  StorageManifestBuildStats,
} from "./execution-storage-manifest.service";
import {
  RunConnectorCatalogSelection,
  effectiveStoredConnectorEnvironment,
  environmentTemplates,
  mergeRecords,
} from "./run-connector-context.service";
import { nativeCredentialEnvironment } from "./run-model-provider-environment.service";
import { PreparedPiLaunchResources } from "./pi-launch-resources.service";

const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

function withOkouTokenSecret(
  body: CreateRunBody,
  okouToken: string,
): CreateRunBody {
  return {
    ...body,
    secrets: {
      ...withoutLegacyAgentRunEnvironmentEntries(body.secrets),
      OKOU_TOKEN: okouToken,
    },
  };
}

export function pendingOkouTokenSecrets(secrets: CreateRunBody["secrets"]) {
  return {
    ...withoutLegacyAgentRunEnvironmentEntries(secrets),
    OKOU_TOKEN: "__pending_okou_token__",
  };
}

interface StoredExecutionSecrets {
  // Runtime secret namespace encrypted into executionContext.encryptedSecrets.
  // Keys are the `NAME` in `${{ secrets.NAME }}`; connector/model-provider
  // entries use env aliases, not backing storage secret names.
  readonly secrets: Record<string, string> | undefined;
  readonly secretConnectorMap: Record<string, string> | null;
  readonly secretConnectorMetadataMap: Record<
    string,
    SecretConnectorMetadata
  > | null;
}

interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: PreparedAgentRunStorage["runContextStorage"];
  readonly secretNames: readonly string[];
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

export type BuiltStoredExecutionContextDraft = Omit<
  BuiltStoredExecutionContext,
  "context" | "persistedStorageMounts" | "runContextStorage"
> & {
  readonly context: Omit<StoredExecutionContext, "storageMounts">;
};

export function runnerProfile(
  content: agentRunCreateAgentExecutionConfig,
): string {
  return firstAgent(content)?.experimental_profile ?? DEFAULT_PROFILE;
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
}

function expandEnvironment(args: {
  readonly content: agentRunCreateAgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly additionalEnvironment: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
  readonly storedConnectorEnvironment: Record<string, string> | undefined;
  readonly connectorVars: Record<string, string> | undefined;
}): Record<string, string> | null {
  const storedConnectorEnvironment = expandStoredConnectorEnvironment({
    environment: effectiveStoredConnectorEnvironment({
      content: args.content,
      additionalEnvironment: args.additionalEnvironment,
      storedConnectorEnvironment: args.storedConnectorEnvironment,
    }),
    vars: args.connectorVars,
    secrets: args.secrets,
    environmentSecretPlaceholders: args.environmentSecretPlaceholders,
  });
  const mergedEnvironment = environmentTemplates({
    content: args.content,
    additionalEnvironment: args.additionalEnvironment,
  });
  if (!mergedEnvironment) {
    return storedConnectorEnvironment ?? null;
  }

  const { result } = expandVariables(mergedEnvironment, {
    vars: args.vars,
    secrets: {
      ...args.secrets,
      ...args.environmentSecretPlaceholders,
    },
  });
  return mergeRecords(result, storedConnectorEnvironment) ?? null;
}

function expandStoredConnectorEnvironment(args: {
  readonly environment: Record<string, string> | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly secrets: Record<string, string> | undefined;
  readonly environmentSecretPlaceholders:
    | Readonly<Record<string, string>>
    | undefined;
}): Record<string, string> | undefined {
  if (!args.environment) {
    return undefined;
  }

  const expanded: Record<string, string> = {};
  const secretSources = mergeRecords(
    args.secrets,
    args.environmentSecretPlaceholders,
  );
  for (const [key, value] of Object.entries(args.environment)) {
    const expansion = expandVariablesInString(value, {
      vars: args.vars,
      secrets: secretSources,
    });
    if (expansion.missingVars.length > 0) {
      throw new Error(
        `Stored connector environment is missing required values: ${formatMissingReferences(expansion.missingVars)}`,
      );
    }
    expanded[key] = expansion.result;
  }
  return compactRecord(expanded);
}

function formatMissingReferences(
  refs: readonly { readonly source: string; readonly name: string }[],
): string {
  return refs
    .map((ref) => {
      return `${ref.source}.${ref.name}`;
    })
    .join(", ");
}

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

export function withoutLegacyAgentRunEnvironmentEntries<T>(
  values: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  if (!values) {
    return undefined;
  }
  const canonical: Record<string, T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("ZERO_")) {
      canonical[key] = value;
    }
  }
  return compactRecord(canonical);
}

function withoutOkouNamespaceEntries<T>(
  values: Readonly<Record<string, T>> | null,
): Record<string, T> | null {
  if (!values) {
    return null;
  }
  const untrusted: Record<string, T> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith("OKOU_")) {
      untrusted[key] = value;
    }
  }
  return compactRecord(untrusted) ?? null;
}

function filterSecretConnectorMap(args: {
  readonly secretConnectorMap: Record<string, string> | undefined;
  readonly overriddenSecrets: readonly (
    | Readonly<Record<string, unknown>>
    | undefined
  )[];
}): Record<string, string> | undefined {
  if (!args.secretConnectorMap) {
    return undefined;
  }

  const overridden = new Set<string>();
  for (const secrets of args.overriddenSecrets) {
    for (const key of Object.keys(secrets ?? {})) {
      overridden.add(key);
    }
  }
  const filtered = Object.fromEntries(
    Object.entries(args.secretConnectorMap).filter(([key]) => {
      return !overridden.has(key);
    }),
  );
  return compactRecord(filtered);
}

function filterSecretConnectorMetadataMap(args: {
  readonly secretConnectorMetadataMap:
    | Record<string, SecretConnectorMetadata>
    | undefined;
  readonly secretConnectorMap: Record<string, string> | undefined;
}): Record<string, SecretConnectorMetadata> | undefined {
  if (!args.secretConnectorMetadataMap || !args.secretConnectorMap) {
    return undefined;
  }

  const filtered: Record<string, SecretConnectorMetadata> = {};
  for (const key of Object.keys(args.secretConnectorMap)) {
    const metadata = args.secretConnectorMetadataMap[key];
    if (metadata) {
      filtered[key] = metadata;
    }
  }
  return compactRecord(filtered);
}

export function overriddenRuntimeSecretAliases(
  records: readonly (Record<string, string> | undefined)[],
): ReadonlySet<string> {
  const aliases = new Set<string>();
  for (const record of records) {
    for (const key of Object.keys(record ?? {})) {
      aliases.add(key);
    }
  }
  return aliases;
}

async function loadRequiredFirewallPermissionIndex(args: {
  readonly snapshot: ConnectorRuntimeSelection;
  readonly connectorSlug: string;
}): Promise<ConnectorServerFirewallPermissionIndex> {
  const index = await args.snapshot.serverFirewalls.loadPermissionIndex(
    args.connectorSlug,
  );
  if (!index) {
    throw new Error(
      `Missing connector server firewall permission metadata: ${args.connectorSlug}`,
    );
  }
  return index;
}

function getRequiredFirewallExecutionMetadata(
  snapshot: ConnectorRuntimeSelection,
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

function inlineFirewallEntry(
  firewall: ExpandedFirewallConfig,
): ExecutionFirewallEntry {
  return { kind: "inline", firewall: runtimeFirewall(firewall) };
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

function modelProviderPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment | null,
  vars: Record<string, string> | undefined,
): PermissionManifest | undefined {
  if (!modelProvider) {
    return undefined;
  }

  const firewall =
    modelProvider.firewall ??
    getModelProviderFirewall(modelProvider.concreteType ?? modelProvider.type);
  if (!firewall) {
    return undefined;
  }

  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [
      // A name-only entry would lose the endpoint selected for this run.
      modelProvider.firewall !== undefined
        ? inlineFirewallEntry(firewall)
        : builtinFirewallEntry(firewall, vars),
    ],
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

interface BuiltinConnectorManifestSource {
  readonly metadata: ConnectorServerFirewallExecutionMetadata;
  readonly permissionIndex: ConnectorServerFirewallPermissionIndex;
  readonly isMcp: boolean;
}

function buildConnectorPermissionBaseline(
  snapshot: ConnectorRuntimeSelection,
  sources: readonly BuiltinConnectorManifestSource[],
): StoredConnectorPermissionBaseline {
  const validationAuthority = currentConnectorCatalogValidatorIdentity();
  return {
    version: 1,
    catalogIdentity: snapshot.catalogIdentity,
    validationAuthority: {
      backendVersion: validationAuthority.validatorVersion,
      buildCommitSha: validationAuthority.buildCommitSha,
    },
    connectors: Object.fromEntries(
      sources.map((source) => {
        const defaultPolicy = source.permissionIndex.defaultPolicy;
        const permissionOverrides = defaultPolicy.permissionOverrides;
        return [
          source.metadata.connectorSlug,
          {
            permissionNames: [...source.permissionIndex.permissionNames],
            defaultPolicy: {
              permissionDefault: defaultPolicy.permissionDefault,
              ...(permissionOverrides
                ? {
                    permissionOverrides: {
                      ...(permissionOverrides.allow
                        ? { allow: [...permissionOverrides.allow] }
                        : {}),
                      ...(permissionOverrides.deny
                        ? { deny: [...permissionOverrides.deny] }
                        : {}),
                      ...(permissionOverrides.ask
                        ? { ask: [...permissionOverrides.ask] }
                        : {}),
                    },
                  }
                : {}),
              unknownPolicy: defaultPolicy.unknownPolicy,
            },
          },
        ];
      }),
    ),
  };
}

function applyBuiltinConnectorMetadataPolicies(
  sources: readonly BuiltinConnectorManifestSource[],
  policies: FirewallPolicies | undefined,
  vars: Record<string, string> | undefined,
  connectorSourceIdBySlug: Readonly<Record<string, string>>,
): PermissionManifest {
  const firewalls: ExecutionFirewalls = [];
  const networkPolicies: NetworkPolicies = {};
  const environmentSecretPlaceholders: Record<string, string> = {};
  const billableFirewalls: string[] = [];

  for (const source of sources) {
    const name = source.metadata.connectorSlug;
    const permissionNames = [...source.permissionIndex.permissionNames];
    const defaultPolicy = defaultFirewallPolicyForPermissionIndex(
      source.permissionIndex,
    );
    const policy = policies?.[name];
    const sourceId = connectorSourceIdBySlug[name];
    if (sourceId === undefined) {
      throw new Error("Missing built-in connector source identity");
    }
    firewalls.push(
      builtinFirewallEntryForMetadata(source.metadata, vars, sourceId),
    );
    if (!source.isMcp) {
      Object.assign(
        environmentSecretPlaceholders,
        source.metadata.placeholderValues,
      );
    }
    if (source.metadata.billable) {
      billableFirewalls.push(name);
    }

    networkPolicies[name] = resolveConnectorNetworkPolicy({
      permissionNames,
      defaultPolicy,
      policy,
    });
  }

  return {
    firewalls,
    networkPolicies,
    environmentSecretPlaceholders: compactRecord(environmentSecretPlaceholders),
    billableFirewalls,
  };
}

function builtinRuntimeTargetRegistration(
  firewall: ExecutionFirewallEntry,
): BuiltinRuntimeTargetRegistration {
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
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly builtinSources: readonly BuiltinConnectorManifestSource[];
  readonly connectorManifest: PermissionManifest;
  readonly customConnectorManifest: Pick<
    PermissionManifest,
    "firewalls" | "networkPolicies"
  >;
  readonly providerManifest: PermissionManifest | undefined;
  readonly customConnectorFirewalls: readonly ExpandedFirewallConfig[];
}): PermissionManifest | undefined {
  const builtinRuntimeTargets = args.connectorManifest.firewalls.map(
    builtinRuntimeTargetRegistration,
  );
  const firewalls = [
    ...(args.providerManifest?.firewalls ?? []),
    ...args.connectorManifest.firewalls,
    ...args.customConnectorManifest.firewalls,
  ];

  if (firewalls.length === 0) {
    return undefined;
  }

  const connectorPermissionBaseline = (() => {
    if (args.builtinSources.length === 0) {
      return undefined;
    }
    if (args.connectorCatalogSelection.kind === "empty") {
      throw new Error("Builtin connector sources require a catalog selection");
    }
    return buildConnectorPermissionBaseline(
      args.connectorCatalogSelection.selection,
      args.builtinSources,
    );
  })();

  return {
    firewalls,
    builtinRuntimeTargets,
    ...(connectorPermissionBaseline ? { connectorPermissionBaseline } : {}),
    environmentSecretPlaceholders: mergeRecords(
      args.providerManifest?.environmentSecretPlaceholders,
      args.connectorManifest.environmentSecretPlaceholders,
      firewallSecretPlaceholdersFromFirewalls(args.customConnectorFirewalls),
    ),
    billableFirewalls: [
      ...(args.providerManifest?.billableFirewalls ?? []),
      ...args.connectorManifest.billableFirewalls,
    ],
    networkPolicies: {
      ...args.providerManifest?.networkPolicies,
      ...args.connectorManifest.networkPolicies,
      ...args.customConnectorManifest.networkPolicies,
    },
  };
}

interface BuildPermissionManifestArgs {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly permissionPolicies: FirewallPolicies | undefined;
  readonly vars: Record<string, string> | undefined;
  readonly connectorVars?: Record<string, string>;
  readonly connectorSlugs?: readonly ConnectorSlug[];
  readonly connectorSourceIdBySlug?: Readonly<Record<string, string>>;
  readonly customConnectorFirewalls?: readonly ExpandedFirewallConfig[];
  readonly customConnectorPermissionPolicies?: FirewallPolicies;
  readonly customConnectorIdByFirewallName?: Readonly<Record<string, string>>;
  readonly customConnectorSourceIdByFirewallName?: Readonly<
    Record<string, string>
  >;
  readonly timing?: ApiDispatchTimingCollector;
}

async function buildPermissionManifest(
  args: BuildPermissionManifestArgs,
): Promise<PermissionManifest | undefined> {
  const connectorBaseUrlVars = mergeRecords(args.vars, args.connectorVars);
  const customConnectorFirewalls = args.customConnectorFirewalls ?? [];

  const builtinSources = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_load_builtin_permission_indexes",
    "nested",
    async () => {
      if (args.connectorCatalogSelection.kind === "empty") {
        return [];
      }
      const snapshot = args.connectorCatalogSelection.selection;
      const builtinConnectorSlugs = (
        args.connectorSlugs ?? Object.keys(args.permissionPolicies ?? {})
      ).filter((connectorSlug) => {
        return snapshot.serverFirewalls.has(connectorSlug);
      });
      return await Promise.all(
        builtinConnectorSlugs.map(async (connectorSlug) => {
          const metadata = getRequiredFirewallExecutionMetadata(
            snapshot,
            connectorSlug,
          );
          const permissionIndex = await loadRequiredFirewallPermissionIndex({
            snapshot,
            connectorSlug,
          });
          return {
            metadata,
            permissionIndex,
            isMcp: snapshot.serverFirewalls.isMcp(connectorSlug),
          };
        }),
      );
    },
  );

  const connectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_builtin_permission_policies",
    "nested",
    () => {
      return Promise.resolve(
        applyBuiltinConnectorMetadataPolicies(
          builtinSources,
          args.permissionPolicies,
          connectorBaseUrlVars,
          args.connectorSourceIdBySlug ?? {},
        ),
      );
    },
  );
  const customConnectorManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_custom_permission_policies",
    "nested",
    () => {
      return Promise.resolve(
        applyConnectorPolicies(
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
        ),
      );
    },
  );
  const providerManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_model_provider_permission_policy",
    "nested",
    () => {
      return Promise.resolve(
        modelProviderPermissionManifest(args.modelProvider, args.vars),
      );
    },
  );

  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_merge_permission_manifest",
    "nested",
    () => {
      return Promise.resolve(
        mergePermissionManifests({
          connectorCatalogSelection: args.connectorCatalogSelection,
          builtinSources,
          connectorManifest,
          customConnectorManifest,
          providerManifest,
          customConnectorFirewalls,
        }),
      );
    },
  );
}

function storedConnectorRuntimeTargets(args: {
  readonly permissionManifest: PermissionManifest | undefined;
  readonly customTargets: readonly ConnectorRuntimeTargetRegistration[];
}): ConnectorRuntimeTargetRegistration[] {
  return [
    ...(args.permissionManifest?.builtinRuntimeTargets ?? []),
    ...args.customTargets,
  ];
}

function buildStoredPlatformEnvironment(args: {
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly canonicalOkouRuntime: boolean;
}): Record<string, string> {
  const platformEnvironment = {
    ...args.platformEnvironment,
    CLI_PKG_URL: env("CLI_PKG_URL"),
  };
  return args.canonicalOkouRuntime
    ? (withoutLegacyAgentRunEnvironmentEntries(platformEnvironment) ?? {})
    : platformEnvironment;
}

function buildStoredUntrustedEnvironment(args: {
  readonly expandedEnvironment: Record<string, string> | null;
  readonly canonicalOkouRuntime: boolean;
}): Record<string, string> | null {
  if (!args.canonicalOkouRuntime) {
    return args.expandedEnvironment;
  }
  return (
    withoutLegacyAgentRunEnvironmentEntries(
      args.expandedEnvironment ?? undefined,
    ) ?? null
  );
}

function assertNativeCredentialOverrides(
  provider: ResolvedModelProviderEnvironment | null,
  bodySecrets: Record<string, string> | undefined,
): void {
  const native = provider?.piModelConfig;
  if (
    native &&
    "schemaVersion" in native &&
    native.schemaVersion === 4 &&
    native.credentialBindings.some((binding) => {
      return bodySecrets?.[binding.secretName] !== undefined;
    })
  ) {
    throw new PiNativeConfigurationError(
      "Native Pi credentials cannot be overridden after route capture",
    );
  }
}

function capturedPiExecutionRoute(
  provider: ResolvedModelProviderEnvironment | null,
): PiExecutionRoute | undefined {
  return provider?.piModelConfig
    ? normalizePiExecutionRoute(provider.piModelConfig)
    : undefined;
}

function assertNativeEnvironment(
  provider: ResolvedModelProviderEnvironment | null,
  effectiveEnvironment: Record<string, string>,
): void {
  const nativeConfig = provider?.piModelConfig;
  if (
    nativeConfig &&
    "schemaVersion" in nativeConfig &&
    nativeConfig.schemaVersion === 4
  ) {
    for (const key of [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_PROFILE",
      "AWS_DEFAULT_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "VERCEL_AI_GATEWAY_API_KEY",
      "OKOU_MODEL_PROVIDER_API_KEY",
    ]) {
      if (effectiveEnvironment[key]) {
        throw new PiNativeConfigurationError(
          "Native Pi context cannot carry ambient provider authentication",
        );
      }
    }
  }
}

function piLangfuseExecutionEnvironment(args: {
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly piSandbox: PiModelConfig | undefined;
  readonly userId: string;
}): {
  readonly platformEnvironment?: Readonly<Record<string, string>>;
} {
  if (!args.includeOkouTokenSecret || args.piSandbox === undefined) {
    return {};
  }
  const config = resolvePiLangfuseDebugConfig(args.featureSwitchContext);
  if (!config) {
    return {};
  }
  return {
    platformEnvironment: piLangfuseDebugPlatformEnvironment({
      userId: args.userId,
    }),
  };
}

/**
 * The Runner's model usage metering fields: billable firewalls, the provider
 * usage is reported under, and the long-context threshold captured from the
 * run's assigned Built-in route (`0`: the route explicitly bills a single
 * tier, so the Runner must not fall back to its generated map).
 */
function modelUsageExecutionFields(args: {
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
}): Pick<
  StoredExecutionContext,
  | "billableFirewalls"
  | "modelUsageProvider"
  | "modelUsageLongContextMinTotalInputTokens"
> {
  return {
    billableFirewalls: [...args.billableFirewalls],
    modelUsageProvider: args.modelUsageProvider,
    modelUsageLongContextMinTotalInputTokens:
      args.modelUsageLongContextMinTotalInputTokens,
  };
}

export function buildStoredExecutionContextDraft(
  args: {
    readonly runId: string;
    readonly userId: string;
    readonly orgId: string;
    readonly chatThreadId: string | undefined;
    readonly resolved: ResolvedRunExecution;
    readonly body: CreateRunBody;
    readonly framework: SupportedFramework;
    readonly piSandbox: PiModelConfig | undefined;
    readonly modelProvider: ResolvedModelProviderEnvironment | null;
    readonly connectorContext: BuiltinConnectorRuntimeContext;
    readonly customConnectorContext: CustomConnectorRuntimeContext;
    readonly permissionManifest: PermissionManifest | undefined;
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly modelUsageLongContextMinTotalInputTokens: number;
    readonly apiStartTime: number;
    readonly additionalVolumes:
      | readonly AgentRunCreateAdditionalVolume[]
      | undefined;
    readonly platformEnvironment: Record<string, string> | undefined;
    readonly userTimezone: string | undefined;
    readonly featureSwitchContext: FeatureSwitchContext;
    readonly includeOkouTokenSecret: boolean | undefined;
  },
  encryptedSecrets: BuiltStoredExecutionContextDraft["context"]["encryptedSecrets"],
): BuiltStoredExecutionContextDraft {
  const permissions = args.permissionManifest;
  const langfuseEnvironment = piLangfuseExecutionEnvironment(args);
  assertNativeCredentialOverrides(args.modelProvider, args.body.secrets);
  const executionSecrets = buildStoredExecutionSecrets({
    connectorContext: args.connectorContext,
    modelProvider: args.modelProvider,
    bodySecrets: args.body.secrets,
    customConnectorContext: args.customConnectorContext,
  });
  const secretNames = executionSecrets.secrets
    ? Object.keys(executionSecrets.secrets)
    : [];
  const secretValues = executionSecrets.secrets
    ? Object.values(executionSecrets.secrets)
    : [];
  const connectorRuntimeTargets = storedConnectorRuntimeTargets({
    permissionManifest: permissions,
    customTargets: args.customConnectorContext.targets,
  });
  // Newly constructed API context: remove the reserved namespace from the
  // fully expanded untrusted/content environment before the trusted overlay.
  const expandedEnvironment = withoutOkouNamespaceEntries(
    expandEnvironment({
      content: args.resolved.content,
      vars: args.body.vars,
      secrets: executionSecrets.secrets,
      additionalEnvironment: args.modelProvider?.environment,
      environmentSecretPlaceholders: permissions?.environmentSecretPlaceholders,
      storedConnectorEnvironment: args.connectorContext.storedEnvironment,
      connectorVars: args.connectorContext.vars,
    }),
  );
  const nativeEnvironment = nativeCredentialEnvironment(
    capturedPiExecutionRoute(args.modelProvider),
  );
  const platformEnvironment = buildStoredPlatformEnvironment({
    platformEnvironment: {
      ...args.platformEnvironment,
      ...nativeEnvironment,
      ...langfuseEnvironment.platformEnvironment,
    },
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const untrustedEnvironment = buildStoredUntrustedEnvironment({
    expandedEnvironment,
    canonicalOkouRuntime: args.includeOkouTokenSecret === true,
  });
  const environment =
    Object.keys(nativeEnvironment).length > 0
      ? { ...untrustedEnvironment, ...nativeEnvironment }
      : untrustedEnvironment;
  const effectiveEnvironment = {
    ...environment,
    ...platformEnvironment,
  };
  assertNativeEnvironment(args.modelProvider, effectiveEnvironment);
  const environmentKeyByValue = new Map<string, string>();
  for (const [key, value] of Object.entries(effectiveEnvironment)) {
    if (!environmentKeyByValue.has(value)) {
      environmentKeyByValue.set(value, key);
    }
  }
  const secretValueEnvironmentKeys = executionSecrets.secrets
    ? secretValues.flatMap((value) => {
        const key = environmentKeyByValue.get(value);
        return key === undefined ? [] : [key];
      })
    : null;
  return {
    context: {
      environment,
      platformEnvironment,
      secretValueEnvironmentKeys,
      vars: args.connectorContext.vars ?? null,
      resumeSession: args.resolved.resumeSession ?? null,
      encryptedSecrets,
      secretConnectorMap: executionSecrets.secretConnectorMap,
      secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
      cliAgentType: args.framework,
      realAgentInPreview: args.body.realAgentInPreview || undefined,
      captureNetworkBodies: args.body.captureNetworkBodies || undefined,
      apiStartTime: args.apiStartTime,
      userTimezone: args.userTimezone,
      firewalls: permissions?.firewalls,
      networkPolicies: permissions?.networkPolicies,
      connectorRuntimeTargets,
      connectorPermissionBaseline: permissions?.connectorPermissionBaseline,
      disallowedTools: args.body.disallowedTools,
      tools: args.body.tools,
      settings: args.body.settings,
      featureFlags: getAllFeatureStates(args.featureSwitchContext),
      ...modelUsageExecutionFields(args),
      codexRuntimeConfig: args.modelProvider?.codexRuntimeConfig ?? null,
    },
    secretNames,
    secretValues,
  };
}

function resolveBuiltStoredExecutionContext(
  preparedStorage: PreparedAgentRunStorage,
  builtContextDraft: BuiltStoredExecutionContextDraft,
): BuiltStoredExecutionContext {
  return {
    ...builtContextDraft,
    persistedStorageMounts: [...preparedStorage.persistedStorageMounts],
    runContextStorage: preparedStorage.runContextStorage,
    context: {
      ...builtContextDraft.context,
      storageMounts: [...preparedStorage.storageMounts],
    },
  };
}

function sanitizeEnvironment(
  environment: Record<string, string> | null | undefined,
  secretValues: readonly string[],
): Record<string, string> {
  const secrets = new Set(secretValues);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    sanitized[key] = secrets.has(value) ? "***" : value;
  }
  return sanitized;
}

function buildRunContextSnapshot(args: {
  readonly runId: string;
  readonly userId: string;
  readonly body: CreateRunBody;
  readonly builtContext: BuiltStoredExecutionContext;
}): RunContextAxiomSnapshot {
  const storedContext = args.builtContext.context;
  const sanitizedEnvironment = sanitizeEnvironment(
    {
      ...storedContext.environment,
      ...storedContext.platformEnvironment,
    },
    args.builtContext.secretValues,
  );
  const cliAgentSessionId =
    storedContext.piSessionId ?? storedContext.resumeSession?.sessionId ?? null;
  const snapshot: RunContextAxiomSnapshot = {
    _time: nowDate().toISOString(),
    runId: args.runId,
    userId: args.userId,
    prompt: args.body.prompt,
    appendSystemPrompt: args.body.appendSystemPrompt ?? null,
    sessionId: cliAgentSessionId,
    cliAgentType: storedContext.cliAgentType,
    ...piModelConfigObservation(
      storedContext.cliAgentType,
      storedContext.piModelConfig,
    ),
    secretNames: [...args.builtContext.secretNames],
    environmentEntries: environmentRecordToEntries(sanitizedEnvironment),
    firewalls: executionFirewallsToAxiomEntries(storedContext.firewalls),
    networkPolicyEntries: networkPoliciesRecordToEntries(
      storedContext.networkPolicies,
    ),
    volumes: args.builtContext.runContextStorage.volumes,
    artifact: args.builtContext.runContextStorage.artifact,
    featureFlagEntries: featureFlagsRecordToEntries(storedContext.featureFlags),
  };
  return snapshot;
}

export function buildStoredExecutionSecrets(args: {
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly bodySecrets: Record<string, string> | undefined;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
}): StoredExecutionSecrets {
  const filteredConnectorMap = filterSecretConnectorMap({
    secretConnectorMap: args.connectorContext.secretConnectorMap,
    overriddenSecrets: [
      args.modelProvider?.secrets,
      args.modelProvider?.secretConnectorMap,
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredModelProviderMap = filterSecretConnectorMap({
    secretConnectorMap: args.modelProvider?.secretConnectorMap,
    overriddenSecrets: [
      args.bodySecrets,
      args.customConnectorContext.reservedSecretAliases,
    ],
  });
  const filteredConnectorMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap:
      args.connectorContext.secretConnectorMetadataMap,
    secretConnectorMap: filteredConnectorMap,
  });
  const filteredModelProviderMetadataMap = filterSecretConnectorMetadataMap({
    secretConnectorMetadataMap: args.modelProvider?.secretConnectorMetadataMap,
    secretConnectorMap: filteredModelProviderMap,
  });
  const secretConnectorMap =
    mergeRecords(filteredConnectorMap, filteredModelProviderMap) ?? null;
  const secretConnectorMetadataMap =
    mergeRecords(
      filteredConnectorMetadataMap,
      filteredModelProviderMetadataMap,
    ) ?? null;
  const secrets = mergeRecords(
    args.connectorContext.secrets,
    args.modelProvider?.secrets,
    args.bodySecrets,
  );
  // The merged map is the runtime `secrets.NAME` namespace consumed by firewall
  // auth and environment expansion. Stored connectors and model providers enter
  // this map under env binding aliases; raw DB storage names stay behind the
  // access metadata used during refresh/lookup.
  return {
    // An explicitly empty namespace still supports dynamic firewall secrets.
    secrets:
      secrets ??
      (args.bodySecrets !== undefined || secretConnectorMap ? {} : undefined),
    secretConnectorMap,
    secretConnectorMetadataMap,
  };
}

function sessionStorageMountsForPersistence(args: {
  readonly resolvedMounts: readonly PersistedStorageMount[];
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}): readonly PersistedStorageMount[] {
  const artifactsByName = new Map<string, AgentRunCreateContextArtifact>();
  for (const artifact of args.artifacts) {
    artifactsByName.set(artifact.name, artifact);
  }

  return args.resolvedMounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    const artifact = artifactsByName.get(mount.name);
    if (!artifact || artifact.mountPath !== mount.mountPath) {
      throw new Error(
        `Resolved writeback Storage "${mount.name}" has no source declaration`,
      );
    }
    const {
      version: _resolvedVersion,
      missingRootPolicy: _resolvedMissingRootPolicy,
      ...mountBase
    } = mount;
    return [
      {
        ...mountBase,
        ...(artifact.version === undefined
          ? {}
          : { version: artifact.version }),
        ...(artifact.missingRootPolicy === undefined
          ? {}
          : { missingRootPolicy: artifact.missingRootPolicy }),
      },
    ];
  });
}

export interface BuildRunnerJobPayloadInput {
  readonly disabledPaidTools: readonly string[];
  readonly capturedStorageMounts?: readonly PersistedStorageMount[];
  readonly deferredPiResources?: PreparedPiLaunchResources;
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly userId: string;
  readonly orgId: string;
  readonly resolved: ResolvedRunExecution;
  readonly body: CreateRunBody;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly framework: SupportedFramework;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly piSandbox: PiModelConfig | undefined;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly connectorContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly billableFirewalls: readonly string[];
  readonly modelUsageProvider: string | undefined;
  readonly modelUsageLongContextMinTotalInputTokens: number;
  readonly apiStartTime: number;
  readonly additionalVolumes:
    | readonly AgentRunCreateAdditionalVolume[]
    | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly includeOkouTokenSecret: boolean | undefined;
  readonly okouTokenComputerUseHostId: string | undefined;
  readonly okouTokenCloudBrowserEnabled: boolean | undefined;
  readonly imageRecognitionAvailable: boolean;
  readonly chatThreadId: string | undefined;
  readonly platformEnvironment: Record<string, string> | undefined;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly piLaunchConfig: CreateAgentRunArgs["piLaunchConfig"];
  readonly artifactMissingRootPolicy: ArtifactMissingRootPolicy | undefined;
}

function withPiMemoryRecallEpoch(
  mounts: readonly PersistedStorageMount[],
  memoryRecall: PiMemoryRecallSelection | undefined,
): readonly PersistedStorageMount[] {
  if (memoryRecall === undefined) {
    return mounts;
  }
  return mounts.map((mount) => {
    if (
      mount.name !== AUTO_MEMORY_ARTIFACT_NAME ||
      mount.mountPath !== PI_MEMORY_ROOT ||
      mount.storageId !== memoryRecall.memoryStorageId ||
      mount.version !== memoryRecall.storageVersionId
    ) {
      return mount;
    }
    return { ...mount, piMemoryRecall: memoryRecall };
  });
}

/**
 * The installed CLI must have this session construction and meet the CLI
 * floor; otherwise the guest uses the commit-addressed package.
 */
const PI_INSTALLED_CLI_REQUIREMENT = {
  requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
  minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
} as const satisfies PiInstalledCliRequirement;

function storedExecutionContextWithPiResources(
  context: StoredExecutionContext,
  resources: PreparedPiLaunchResources | undefined,
  launchFramework: AgentRunFullLaunchSnapshot["framework"],
): StoredExecutionContext {
  const finalizedContext = { ...context, cliAgentType: launchFramework };
  if (resources === undefined) {
    return finalizedContext;
  }
  return {
    ...finalizedContext,
    resumeSession: resources.resumeSession ?? null,
    piSessionId: resources.sessionId,
    piLaunchConfig: resources.launchConfig,
    piModelConfig: resources.modelConfig,
    piInstalledCliRequirement: PI_INSTALLED_CLI_REQUIREMENT,
  };
}

function preparedRunnerGroup(
  content: agentRunCreateAgentExecutionConfig,
): string {
  const group = runnerGroup(content) ?? optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

export function preparedRunnerJobBody(
  args: BuildRunnerJobPayloadInput,
): CreateRunBody {
  if (!args.includeOkouTokenSecret) {
    return args.body;
  }
  const customConnectorSourceEntries =
    args.customConnectorContext.targets.flatMap((target) => {
      return target.kind === "custom" && target.sourceId
        ? [[target.customConnectorId, target.sourceId] as const]
        : [];
    });
  const builtinMcpSlugs = new Set(args.connectorContext.mcpConnectorSlugs);
  const builtinConnectorSourceEntries = (
    args.permissionManifest?.builtinRuntimeTargets ?? []
  ).flatMap((target) => {
    return target.kind === "builtin" &&
      target.sourceId !== undefined &&
      builtinMcpSlugs.has(target.connectorSlug)
      ? [[target.connectorSlug, target.sourceId] as const]
      : [];
  });
  const okouToken = generateOkouToken(
    args.userId,
    args.run.id,
    args.orgId,
    args.featureSwitchContext.overrides,
    {
      ...(args.okouTokenComputerUseHostId
        ? { computerUseHostId: args.okouTokenComputerUseHostId }
        : {}),
      cloudBrowserEnabled: args.okouTokenCloudBrowserEnabled === true,
      imageRecognitionAvailable: args.imageRecognitionAvailable,
      ...(customConnectorSourceEntries.length === 0
        ? {}
        : {
            customConnectorSourceIds: Object.fromEntries(
              customConnectorSourceEntries,
            ),
          }),
      ...(builtinConnectorSourceEntries.length === 0
        ? {}
        : {
            builtinConnectorSourceIds: Object.fromEntries(
              builtinConnectorSourceEntries,
            ),
          }),
    },
  );
  return withOkouTokenSecret(args.body, okouToken);
}

function okouTokenEnvironment(body: CreateRunBody): Record<string, string> {
  const okouToken = body.secrets?.OKOU_TOKEN;
  if (!okouToken) {
    throw new Error("The Okou run token is missing from the run context");
  }
  return { OKOU_TOKEN: okouToken };
}

export function withPaidToolPlatformEnvironment(
  owner: Pick<
    BuildRunnerJobPayloadInput,
    "framework" | "modelProvider" | "piSandbox" | "disabledPaidTools"
  >,
  platformEnvironment: Record<string, string> | undefined,
): Record<string, string> {
  const disabledTools = owner.disabledPaidTools;
  const environment: Record<string, string> = {
    ...platformEnvironment,
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(disabledTools),
  };
  if (shouldEnableFrameworkWebSearch(owner, disabledTools)) {
    environment[ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR] = "true";
  } else {
    delete environment[ENABLE_FRAMEWORK_WEB_SEARCH_ENV_VAR];
  }
  return environment;
}

function shouldEnableFrameworkWebSearch(
  context: Pick<
    BuildRunnerJobPayloadInput,
    "framework" | "modelProvider" | "piSandbox"
  >,
  disabledTools: readonly string[],
): boolean {
  if (
    context.piSandbox !== undefined ||
    !disabledTools.includes("web-search") ||
    (context.framework !== "claude-code" && context.framework !== "codex")
  ) {
    return false;
  }

  // A successful route without a stored provider uses the framework key
  // declared in compose. Stored non-built-in providers are BYOK as well.
  return (
    context.modelProvider === null ||
    !isBuiltInModelProviderType(context.modelProvider.type)
  );
}

function finalizedRunnerLaunch({
  args,
  group,
  body,
  checkpointArtifacts,
  builtContext,
  piResources,
}: {
  args: BuildRunnerJobPayloadInput;
  group: string;
  body: ReturnType<typeof preparedRunnerJobBody>;
  checkpointArtifacts: BuildRunnerJobPayloadInput["artifacts"];
  builtContext: BuiltStoredExecutionContext;
  piResources: PreparedPiLaunchResources | undefined;
}): PreparedRunnerLaunch {
  const storedContext = storedExecutionContextWithPiResources(
    builtContext.context,
    piResources,
    args.launchSnapshot.framework,
  );
  const persistedStorageMounts = withPiMemoryRecallEpoch(
    builtContext.persistedStorageMounts,
    piResources?.memoryRecall,
  );
  const runContextSnapshot = buildRunContextSnapshot({
    runId: args.run.id,
    userId: args.userId,
    body,
    builtContext: { ...builtContext, context: storedContext },
  });
  const cliAgentSessionId =
    storedContext.piSessionId ?? storedContext.resumeSession?.sessionId ?? null;
  return {
    runnerJobPayload: runnerJobPayload({
      runnerGroup: group,
      profile: args.launchSnapshot.runnerProfile,
      cliAgentSessionId,
      reuseKey: runnerReuseKey(args.chatThreadId),
      executionContext: storedContext,
    }),
    runContextSnapshot,
    runStorageMounts: persistedStorageMounts,
    sessionStorageMounts: sessionStorageMountsForPersistence({
      resolvedMounts: persistedStorageMounts,
      artifacts: checkpointArtifacts,
    }),
  };
}

export interface StorageMaterializationInput {
  readonly db: Db;
  readonly args: BuildRunnerJobPayloadInput;
  readonly storageManifestStats: StorageManifestBuildStats;
}

export function runnerCheckpointArtifacts(args: BuildRunnerJobPayloadInput) {
  return args.artifactMissingRootPolicy === undefined
    ? args.artifacts
    : args.artifacts.map((artifact) => {
        return {
          ...artifact,
          missingRootPolicy: args.artifactMissingRootPolicy,
        };
      });
}

export function prepareRunnerStorageInput(input: StorageMaterializationInput) {
  const { db, args, storageManifestStats } = input;
  const body = preparedRunnerJobBody(args);
  return {
    db,
    args,
    storageManifestStats,
    body,
    checkpointArtifacts: runnerCheckpointArtifacts(args),
    group: preparedRunnerGroup(args.resolved.content),
    platformEnvironment: args.includeOkouTokenSecret
      ? { ...args.platformEnvironment, ...okouTokenEnvironment(body) }
      : args.platformEnvironment,
  };
}

export interface MaterializedRunnerStorage {
  readonly input: ReturnType<typeof prepareRunnerStorageInput>;
  readonly preparedStorage: MaterializedAgentRunStorage;
  readonly piResources: PreparedPiLaunchResources | undefined;
}

export function atomicLaunchPayloadInput(args: {
  readonly capturedStorageMounts?: readonly PersistedStorageMount[];
  readonly deferredPiResources?: PreparedPiLaunchResources;
  readonly createArgs: CreateAgentRunArgs;
  readonly context: FinalizedPreparedRunContext;
  readonly run: Pick<RunRecord, "id" | "sessionId" | "shouldCreateSession">;
  readonly timing: ApiDispatchTimingCollector;
}): BuildRunnerJobPayloadInput {
  return {
    disabledPaidTools: args.context.disabledPaidTools,
    run: args.run,
    deferredPiResources: args.deferredPiResources,
    capturedStorageMounts: args.capturedStorageMounts,
    userId: args.createArgs.userId,
    orgId: args.createArgs.orgId,
    resolved: args.context.resolved,
    body: args.context.body,
    artifacts: args.context.artifacts,
    framework: args.context.framework,
    launchSnapshot: args.context.launchSnapshot,
    piSandbox: args.context.piSandbox,
    modelProvider: args.context.modelProvider,
    connectorContext: args.context.connectorContext,
    customConnectorContext: args.context.customConnectorContext,
    permissionManifest: args.context.permissionManifest,
    billableFirewalls: args.context.billableFirewalls,
    modelUsageProvider: args.context.modelUsageProvider,
    modelUsageLongContextMinTotalInputTokens:
      args.context.modelUsageLongContextMinTotalInputTokens,
    apiStartTime: args.createArgs.apiStartTime,
    additionalVolumes: args.context.additionalVolumes,
    additionalVolumeSources: args.context.additionalVolumeSources,
    includeOkouTokenSecret: args.createArgs.includeOkouTokenSecret,
    okouTokenComputerUseHostId: args.createArgs.okouTokenComputerUseHostId,
    okouTokenCloudBrowserEnabled: args.createArgs.okouTokenCloudBrowserEnabled,
    imageRecognitionAvailable: args.context.imageRecognitionAvailable,
    chatThreadId: args.createArgs.chatThreadId,
    platformEnvironment: args.createArgs.platformEnvironment,
    userTimezone: args.context.userTimezone,
    featureSwitchContext: args.context.featureSwitchContext,
    timing: args.timing,
    piLaunchConfig: args.createArgs.piLaunchConfig,
    artifactMissingRootPolicy: args.createArgs.artifactMissingRootPolicy,
  };
}

export async function buildPreparedPermissionManifest(args: {
  readonly connectorCatalogSelection: RunConnectorCatalogSelection;
  readonly body: Pick<CreateRunBody, "permissionPolicies" | "vars" | "secrets">;
  readonly modelProvider: ResolvedModelProviderEnvironment | null;
  readonly storedConnectorMetadataContext: BuiltinConnectorRuntimeContext;
  readonly customConnectorContext: CustomConnectorRuntimeContext;
  readonly timing: ApiDispatchTimingCollector;
}): Promise<PermissionManifest | undefined | CreateRunErrorResult> {
  const result = await settle(
    buildPermissionManifest({
      connectorCatalogSelection: args.connectorCatalogSelection,
      modelProvider: args.modelProvider,
      permissionPolicies: args.body.permissionPolicies,
      vars: args.body.vars,
      connectorVars: args.storedConnectorMetadataContext.vars,
      connectorSlugs: args.storedConnectorMetadataContext.connectorSlugs,
      connectorSourceIdBySlug:
        args.storedConnectorMetadataContext.connectorSourceIdBySlug,
      customConnectorFirewalls: args.customConnectorContext.firewalls,
      customConnectorPermissionPolicies:
        args.customConnectorContext.permissionPolicies,
      customConnectorIdByFirewallName:
        args.customConnectorContext.customConnectorIdByFirewallName,
      customConnectorSourceIdByFirewallName:
        args.customConnectorContext.customConnectorSourceIdByFirewallName,
      timing: args.timing,
    }),
  );
  if (result.ok) {
    return result.value;
  }
  if (result.error instanceof FirewallBaseUrlResolutionError) {
    return badRequestMessage(result.error.message);
  }
  throw result.error;
}

export interface AtomicLaunchRunInput {
  readonly db: Db;
  readonly args: CreateAgentRunArgs;
  readonly enforceBuiltInCredits: boolean;
  readonly context: FinalizedPreparedRunContext;
  readonly timing: ApiDispatchTimingCollector;
  readonly phaseTiming: ApiDispatchPhaseCollector;
}

export function finalizedMaterializedLaunch(
  storage: MaterializedRunnerStorage,
  contextDraft: BuiltStoredExecutionContextDraft,
): PreparedRunnerLaunch {
  const { args, group, body, checkpointArtifacts } = storage.input;
  return finalizedRunnerLaunch({
    args,
    group,
    body,
    checkpointArtifacts,
    builtContext: resolveBuiltStoredExecutionContext(
      storage.preparedStorage.prepared,
      contextDraft,
    ),
    piResources: storage.piResources,
  });
}
