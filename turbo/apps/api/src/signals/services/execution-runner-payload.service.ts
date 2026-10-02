/**
 * Runner payload assembly shared by execution owners: stored execution context
 * draft and secrets, permission manifest, runner storage input and the
 * finalized materialized launch. Moved verbatim out of the legacy execution
 * graph.
 */
import { nowDate } from "../../lib/time";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
} from "./api-dispatch-timing.service";
import type { PersistedStorageMount } from "@okouai/db/types";
import { optionalEnv } from "../../lib/env";
import {
  type StoredExecutionContext,
  type StoredConnectorPermissionBaseline,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  type PiInstalledCliRequirement,
} from "@okouai/api-contracts/contracts/runners";
import type { AgentRunFullLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { getModelProviderFirewall } from "@okouai/api-contracts/contracts/model-providers";
import {
  type ExpandedFirewallConfig,
  type ExecutionFirewalls,
  type NetworkPolicies,
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
  compactRecord,
  allAllowPolicyForPermissions,
  resolveConnectorNetworkPolicy,
  collectPermissionNames,
  customConnectorRuntimeFirewall,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";
import {
  AgentRunCreateContextArtifact,
  BuiltinRuntimeTargetRegistration,
  CreateRunBody,
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./execution-launch-persistence.service";
import { PreparedAgentRunStorage } from "./execution-storage-manifest.service";
import {
  RunConnectorCatalogSelection,
  mergeRecords,
} from "./run-connector-context.service";
import { PreparedPiLaunchResources } from "./pi-launch-resources.service";

const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

export interface BuiltStoredExecutionContext {
  readonly context: StoredExecutionContext;
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: PreparedAgentRunStorage["runContextStorage"];
  readonly secretNames: readonly string[];
  // Plain secret values used for run-context redaction; values, not names.
  readonly secretValues: readonly string[];
}

function isOfficialRunnerGroup(group: string): boolean {
  return group.split("/")[0] === "vm0";
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

export function withoutOkouNamespaceEntries<T>(
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

export async function buildPermissionManifest(
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

export function capturedPiExecutionRoute(
  provider: ResolvedModelProviderEnvironment | null,
): PiExecutionRoute | undefined {
  return provider?.piModelConfig
    ? normalizePiExecutionRoute(provider.piModelConfig)
    : undefined;
}

export function assertNativeEnvironment(
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

export function buildRunContextSnapshot(args: {
  readonly runId: string;
  readonly userId: string;
  readonly body: Pick<CreateRunBody, "prompt" | "appendSystemPrompt">;
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

export function sessionStorageMountsForPersistence(args: {
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

/**
 * The installed CLI must have this session construction and meet the CLI
 * floor; otherwise the guest uses the commit-addressed package.
 */
const PI_INSTALLED_CLI_REQUIREMENT = {
  requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
  minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
} as const satisfies PiInstalledCliRequirement;

export function storedExecutionContextWithPiResources(
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

export function officialRunnerGroup(group: string | undefined): string {
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (!isOfficialRunnerGroup(group)) {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

/** The deployment's default executor group, for runs with no Agent override. */
export function defaultRunnerGroup(): string {
  return officialRunnerGroup(optionalEnv("RUNNER_DEFAULT_GROUP"));
}

/** The model source's own firewall and network policy, with no connectors. */
export async function modelProviderExecutionPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment,
  timing: ApiDispatchTimingCollector,
): Promise<PermissionManifest | undefined> {
  return await buildPermissionManifest({
    connectorCatalogSelection: { kind: "empty" },
    modelProvider,
    permissionPolicies: undefined,
    vars: undefined,
    timing,
  });
}
