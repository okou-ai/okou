/**
 * Pi memory maintenance's private Runner payload, run rows and pending
 * persistence. Pi assembles them from its own facts only — the claimed job,
 * the pinned model source, the exact memory mount and the maintenance
 * launch — and reuses only the Runner protocol types and the approved
 * resource interfaces; its Runner payload helpers are its own.
 * Only pi-memory-maintenance-execution.service.ts imports this module.
 */
import {
  DEFAULT_PROFILE,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type PiInstalledCliRequirement,
  type PiLaunchConfig,
  type PiModelConfig,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
  normalizePiExecutionRoute,
} from "@okouai/pi-agent-runtime";
import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import {
  type FeatureSwitchContext,
  getAllFeatureStates,
} from "@okouai/core/feature-switch";
import { expandVariables } from "@okouai/core/variable-expander";
import type { ImageModel } from "@okouai/core/image-model-catalog";
import type { AgentRunFullLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import type { PersistedStorageMount } from "@okouai/db/types";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { env, optionalEnv } from "../../lib/env";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { nowDate } from "../../lib/time";
import type { Tx } from "../../lib/db-types";
import { isPiLangfuseDebugRunEnvironment } from "../../lib/pi-langfuse-debug";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { safeSync } from "../utils";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { normalizeRunMetadata } from "./agent-run-metadata-write.service";
import type { AgentRunModelPin } from "./agent-run-contracts";
import {
  type PermissionManifest,
  type ResolvedModelProviderEnvironment,
  nativeCredentialEnvironment,
} from "./execution-model-source.service";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import { PiNativeConfigurationError } from "./pi-native-model-config";
import {
  type RunContextAxiomSnapshot,
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
} from "./run-context-snapshot.service";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import {
  isPersonalSubscriptionProviderType,
  validatePersonalSubscriptionAdmission,
} from "./model-provider-account.service";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";

/**
 * The Runner protocol routes every job to an executor group and profile. A
 * maintenance run has no Agent to override them, so it uses the deployment's
 * default executor group and the default profile.
 */
export function maintenanceRunnerGroup(): string {
  const group = optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (group.split("/")[0] !== "vm0") {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

export const MAINTENANCE_RUNNER_PROFILE = DEFAULT_PROFILE;

function compact<T>(
  values: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  return values && Object.keys(values).length > 0 ? { ...values } : undefined;
}

/** The model source's runtime `secrets.NAME` namespace and access metadata. */
export function maintenanceExecutionSecrets(
  modelProvider: ResolvedModelProviderEnvironment,
) {
  const secretConnectorMap = compact(modelProvider.secretConnectorMap);
  const metadata = secretConnectorMap
    ? compact(
        Object.fromEntries(
          Object.keys(secretConnectorMap).flatMap((key) => {
            const entry = modelProvider.secretConnectorMetadataMap?.[key];
            return entry ? [[key, entry] as const] : [];
          }),
        ),
      )
    : undefined;
  return {
    // An explicitly empty namespace still supports dynamic model secrets.
    secrets: compact(modelProvider.secrets) ?? {},
    secretConnectorMap: secretConnectorMap ?? null,
    secretConnectorMetadataMap: metadata ?? null,
  };
}

/** Model environment templates expanded with the model's own secrets. */
function maintenanceModelEnvironment(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly secrets: Record<string, string>;
  readonly placeholders: Readonly<Record<string, string>> | undefined;
}): Record<string, string> | null {
  const templates = compact(args.modelProvider.environment);
  if (!templates) {
    return null;
  }
  const { result } = expandVariables(templates, {
    vars: undefined,
    secrets: { ...args.secrets, ...args.placeholders },
  });
  // OKOU_* names belong to the platform; a model template cannot set them.
  return (
    compact(
      Object.fromEntries(
        Object.entries(result).filter(([key]) => {
          return !key.startsWith("OKOU_");
        }),
      ),
    ) ?? null
  );
}

/** Credentials a native Pi configuration must never receive ambiently. */
const AMBIENT_PROVIDER_AUTH_KEYS = [
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
] as const;

function assertNoAmbientProviderAuth(
  modelConfig: PiModelConfig,
  effectiveEnvironment: Record<string, string>,
): void {
  if (!("schemaVersion" in modelConfig) || modelConfig.schemaVersion !== 4) {
    return;
  }
  for (const key of AMBIENT_PROVIDER_AUTH_KEYS) {
    if (effectiveEnvironment[key]) {
      throw new PiNativeConfigurationError(
        "Native Pi context cannot carry ambient provider authentication",
      );
    }
  }
}

/**
 * The installed CLI must have this session construction and meet the CLI
 * floor; otherwise the guest uses the commit-addressed package.
 */
const MAINTENANCE_PI_CLI_REQUIREMENT = {
  requiredPiAgentRuntimeVersion: PI_AGENT_RUNTIME_VERSION,
  minCliVersion: PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  requiredPiSessionConstructionDigest: PI_SESSION_CONSTRUCTION_DIGEST,
} as const satisfies PiInstalledCliRequirement;

/** The Pi session and launch configuration of one maintenance run. */
export interface MaintenancePiLaunch {
  readonly modelConfig: PiModelConfig;
  readonly maintenance: NonNullable<PiLaunchConfig["maintenance"]>;
  readonly sessionId: string;
}

interface MaintenanceExecutionContextInput {
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly permissionManifest: PermissionManifest | undefined;
  readonly usage: {
    readonly billableFirewalls: readonly string[];
    readonly modelUsageProvider: string | undefined;
    readonly modelUsageLongContextMinTotalInputTokens: number;
  };
  readonly encryptedSecrets: StoredExecutionContext["encryptedSecrets"];
  readonly disabledPaidTools: readonly string[];
  readonly apiStartTime: number;
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly storageMounts: StoredExecutionContext["storageMounts"];
  readonly pi: MaintenancePiLaunch;
}

/** The Runner's stored execution context for one maintenance run. */
export function buildMaintenanceExecutionContext(
  args: MaintenanceExecutionContextInput,
) {
  const permissions = args.permissionManifest;
  const executionSecrets = maintenanceExecutionSecrets(args.modelProvider);
  const nativeEnvironment = nativeCredentialEnvironment(
    args.modelProvider.piModelConfig
      ? normalizePiExecutionRoute(args.modelProvider.piModelConfig)
      : undefined,
  );
  const platformEnvironment = {
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(args.disabledPaidTools),
    ...nativeEnvironment,
    CLI_PKG_URL: env("CLI_PKG_URL"),
  };
  const modelEnvironment = maintenanceModelEnvironment({
    modelProvider: args.modelProvider,
    secrets: executionSecrets.secrets,
    placeholders: permissions?.environmentSecretPlaceholders,
  });
  const environment =
    Object.keys(nativeEnvironment).length > 0
      ? { ...modelEnvironment, ...nativeEnvironment }
      : modelEnvironment;
  const effectiveEnvironment = { ...environment, ...platformEnvironment };
  if (args.modelProvider.piModelConfig) {
    assertNoAmbientProviderAuth(
      args.modelProvider.piModelConfig,
      effectiveEnvironment,
    );
  }
  const secretValues = Object.values(executionSecrets.secrets);
  const environmentKeyByValue = new Map<string, string>();
  for (const [key, value] of Object.entries(effectiveEnvironment)) {
    if (!environmentKeyByValue.has(value)) {
      environmentKeyByValue.set(value, key);
    }
  }
  const context: StoredExecutionContext = {
    environment,
    platformEnvironment,
    secretValueEnvironmentKeys: secretValues.flatMap((value) => {
      const key = environmentKeyByValue.get(value);
      return key === undefined ? [] : [key];
    }),
    vars: null,
    resumeSession: null,
    encryptedSecrets: args.encryptedSecrets,
    secretConnectorMap: executionSecrets.secretConnectorMap,
    secretConnectorMetadataMap: executionSecrets.secretConnectorMetadataMap,
    cliAgentType: "pi",
    apiStartTime: args.apiStartTime,
    userTimezone: args.userTimezone,
    firewalls: permissions?.firewalls,
    networkPolicies: permissions?.networkPolicies,
    connectorRuntimeTargets: [...(permissions?.builtinRuntimeTargets ?? [])],
    connectorPermissionBaseline: permissions?.connectorPermissionBaseline,
    featureFlags: getAllFeatureStates(args.featureSwitchContext),
    billableFirewalls: [...args.usage.billableFirewalls],
    modelUsageProvider: args.usage.modelUsageProvider,
    modelUsageLongContextMinTotalInputTokens:
      args.usage.modelUsageLongContextMinTotalInputTokens,
    codexRuntimeConfig: args.modelProvider.codexRuntimeConfig ?? null,
    storageMounts: args.storageMounts,
    piSessionId: args.pi.sessionId,
    piLaunchConfig: { schemaVersion: 2, maintenance: args.pi.maintenance },
    piModelConfig: args.pi.modelConfig,
    piInstalledCliRequirement: MAINTENANCE_PI_CLI_REQUIREMENT,
  };
  return {
    context,
    secretNames: Object.keys(executionSecrets.secrets),
    secretValues,
  };
}

/** The maintenance run's identity, prompt and recorded launch facts. */
export interface MaintenanceRunRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly apiStartTime: number;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly modelPin: AgentRunModelPin;
  readonly selectedImageModel: ImageModel;
  readonly callback: {
    readonly internalKind: "pi-memory:phase2";
    readonly payload: unknown;
  };
}

function maintenanceRunMetadata(record: MaintenanceRunRecord) {
  const exactSubscriptionId = isPersonalSubscriptionProviderType(
    record.modelProvider.type,
  )
    ? record.modelProvider.id
    : undefined;
  const route = record.modelProvider.builtInModelRuntimeRoute;
  return normalizeRunMetadata({
    // Maintenance runs are agent-triggered, as on every earlier release.
    triggerSource: "agent",
    modelProvider: record.modelPin.modelProvider,
    modelProviderId: exactSubscriptionId ?? record.modelPin.modelProviderId,
    modelProviderCredentialScope: record.modelPin.modelProviderCredentialScope,
    selectedModel: record.modelPin.selectedModel,
    modelRuntimeProvider: route?.providerType ?? null,
    modelRuntimeModel: route?.upstreamModel ?? null,
    builtInModelKeyId: route?.modelKeyId ?? null,
    selectedImageModel: record.selectedImageModel,
    chatThreadId: null,
    apiStartedAt: new Date(record.apiStartTime),
    firstAssistantEventAcknowledgedAt: null,
    summary: null,
  });
}

function maintenanceRunValues(args: {
  readonly record: MaintenanceRunRecord;
  readonly createdAt: Date;
  readonly status: "pending" | "failed";
  readonly runStorageMounts: readonly PersistedStorageMount[] | null;
  readonly runnerGroup: string | null;
  readonly langfuseTraceEnabled: boolean;
  readonly creditAdmitted: boolean;
  readonly accountIdentity: string | null;
  readonly error: string | null;
}): typeof agentRuns.$inferInsert {
  const { record } = args;
  return {
    id: record.runId,
    createdAt: args.createdAt,
    userId: record.userId,
    orgId: record.orgId,
    status: args.status,
    creditAdmitted: args.creditAdmitted,
    prompt: record.prompt,
    appendSystemPrompt: record.appendSystemPrompt,
    vars: null,
    // The model's dynamic secrets use an explicitly empty run namespace.
    secretNames: [],
    storageMounts: args.runStorageMounts ? [...args.runStorageMounts] : null,
    continuedFromSessionId: null,
    sessionId: record.sessionId,
    runnerGroup: args.runnerGroup,
    launchSnapshot: record.launchSnapshot,
    langfuseTraceEnabled: args.langfuseTraceEnabled,
    officialWorkflowProvenance: null,
    completedAt: args.status === "failed" ? args.createdAt : null,
    error: args.error,
    modelProviderAccountIdentity: args.accountIdentity,
    ...maintenanceRunMetadata(record),
  };
}

async function insertMaintenanceRunRows(
  tx: Tx,
  args: Parameters<typeof maintenanceRunValues>[0] & {
    readonly sessionStorageMounts: readonly PersistedStorageMount[] | null;
  },
): Promise<void> {
  const { record } = args;
  await tx.insert(agentSessions).values({
    id: record.sessionId,
    userId: record.userId,
    orgId: record.orgId,
    agentId: null,
    storageMounts: args.sessionStorageMounts
      ? [...args.sessionStorageMounts]
      : null,
    conversationId: null,
  });
  await tx.insert(agentRuns).values(maintenanceRunValues(args));
  await tx.insert(agentRunCallbacks).values({
    runId: record.runId,
    url: null,
    internalKind: record.callback.internalKind,
    encryptedSecret: null,
    payload: record.callback.payload,
  });
  const capture = billingRunAttributionWrite({
    id: record.runId,
    orgId: record.orgId,
    userId: record.userId,
    startedAt: args.createdAt.toISOString(),
    triggerSource: "agent",
    threadId: null,
  });
  const [attribution] = await tx
    .insert(billingRunAttribution)
    .values(capture.values)
    .onConflictDoUpdate(capture.conflict)
    .returning({ id: billingRunAttribution.runId });
  if (!attribution) {
    throw new Error("New Run billing attribution conflicts with history");
  }
}

/** Re-validates a captured member subscription and returns its identity. */
export async function validateMaintenanceSubscription(
  tx: Tx,
  record: Pick<MaintenanceRunRecord, "modelProvider" | "orgId" | "userId">,
): Promise<{ readonly identity: string | null } | null> {
  const provider = record.modelProvider;
  if (
    !isPersonalSubscriptionProviderType(provider.type) ||
    provider.credentialOwner !== "member"
  ) {
    return { identity: null };
  }
  const account = await validatePersonalSubscriptionAdmission({
    db: tx,
    orgId: record.orgId,
    userId: record.userId,
    type: provider.type,
    sourceId: provider.id ?? undefined,
  });
  return account
    ? { identity: personalSubscriptionAccountIdentity(account) }
    : null;
}

/** The failed run record with its callback row; no Runner job. */
export async function insertFailedMaintenanceRun(
  tx: Tx,
  record: MaintenanceRunRecord,
  error: string,
): Promise<void> {
  await insertMaintenanceRunRows(tx, {
    record,
    createdAt: nowDate(),
    status: "failed",
    runStorageMounts: null,
    sessionStorageMounts: null,
    runnerGroup: null,
    langfuseTraceEnabled: false,
    creditAdmitted: false,
    accountIdentity: null,
    error,
  });
}

export interface MaintenanceLaunch {
  readonly runnerGroup: string;
  readonly context: StoredExecutionContext;
  readonly secretNames: readonly string[];
  readonly secretValues: readonly string[];
  readonly runStorageMounts: readonly PersistedStorageMount[];
  readonly sessionStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: {
    readonly volumes: RunContextResponse["volumes"];
    readonly artifact: RunContextResponse["artifact"];
  };
}

/** Session, run, callback, attribution, diagnostic registration and job. */
export async function insertPendingMaintenanceRun(
  tx: Tx,
  args: {
    readonly record: MaintenanceRunRecord;
    readonly launch: MaintenanceLaunch;
    readonly creditAdmitted: boolean;
    readonly accountIdentity: string | null;
  },
): Promise<{ readonly createdAt: Date; readonly runnerJobCreatedAt: Date }> {
  const { record, launch } = args;
  const createdAt = nowDate();
  const runnerGroup = launch.runnerGroup;
  await insertMaintenanceRunRows(tx, {
    record,
    createdAt,
    status: "pending",
    runStorageMounts: launch.runStorageMounts,
    sessionStorageMounts: launch.sessionStorageMounts,
    runnerGroup,
    langfuseTraceEnabled: isPiLangfuseDebugRunEnvironment(
      launch.context.platformEnvironment,
    ),
    creditAdmitted: args.creditAdmitted,
    accountIdentity: args.accountIdentity,
    error: null,
  });
  await tx.insert(agentRunConnectorDiagnosticRegistrations).values({
    runId: record.runId,
    payload: agentRunConnectorDiagnosticRegistrationPayloadSchema.parse({
      version: 1,
      targets: launch.context.connectorRuntimeTargets,
    }),
    createdAt,
  });
  const payload = maintenanceJobPayload(launch);
  const [job] = await tx
    .insert(runnerJobQueue)
    .values({
      runId: record.runId,
      runnerGroup: payload.runnerGroup,
      profile: payload.profile,
      cliAgentSessionId: payload.cliAgentSessionId,
      reuseKey: payload.reuseKey,
      executionContext: payload.executionContext,
      ...runnerJobQueueTimestamps(),
    })
    .returning({ createdAt: runnerJobQueue.createdAt });
  if (!job) {
    throw new Error("Pi maintenance Runner job was not persisted");
  }
  return { createdAt, runnerJobCreatedAt: job.createdAt };
}

function maintenanceJobPayload(launch: MaintenanceLaunch) {
  return {
    runnerGroup: launch.runnerGroup,
    profile: MAINTENANCE_RUNNER_PROFILE,
    cliAgentSessionId: launch.context.piSessionId ?? null,
    // Maintenance runs never share a sandbox with a thread.
    reuseKey: null,
    historyGenerationRunId: historyGenerationRunIdForStoredExecutionContext(
      launch.context,
    ),
    executionContext: launch.context,
  };
}

/** Environment values that are model secrets are masked in telemetry. */
function maskedEnvironment(
  environment: Record<string, string>,
  secretValues: readonly string[],
): Record<string, string> {
  const secrets = new Set(secretValues);
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    masked[key] = secrets.has(value) ? "***" : value;
  }
  return masked;
}

function maintenanceRunContextSnapshot(
  record: MaintenanceRunRecord,
  launch: MaintenanceLaunch,
): RunContextAxiomSnapshot {
  const { context } = launch;
  return {
    _time: nowDate().toISOString(),
    runId: record.runId,
    userId: record.userId,
    prompt: record.prompt,
    appendSystemPrompt: record.appendSystemPrompt,
    sessionId: context.piSessionId ?? context.resumeSession?.sessionId ?? null,
    cliAgentType: context.cliAgentType,
    ...piModelConfigObservation(context.cliAgentType, context.piModelConfig),
    secretNames: [...launch.secretNames],
    environmentEntries: environmentRecordToEntries(
      maskedEnvironment(
        { ...context.environment, ...context.platformEnvironment },
        launch.secretValues,
      ),
    ),
    firewalls: executionFirewallsToAxiomEntries(context.firewalls),
    networkPolicyEntries: networkPoliciesRecordToEntries(
      context.networkPolicies,
    ),
    volumes: launch.runContextStorage.volumes,
    artifact: launch.runContextStorage.artifact,
    featureFlagEntries: featureFlagsRecordToEntries(context.featureFlags),
  };
}

/** Best-effort run-context telemetry for the committed run. */
export function ingestMaintenanceRunContext(
  record: MaintenanceRunRecord,
  launch: MaintenanceLaunch,
): void {
  safeSync(() => {
    return ingestToAxiom(getDatasetName("run-context"), [
      maintenanceRunContextSnapshot(record, launch),
    ]);
  });
}

/** The post-commit Runner notification for the committed job. */
export function maintenanceRunnerNotification(
  record: MaintenanceRunRecord,
  launch: MaintenanceLaunch,
  runnerJobCreatedAt: Date,
): PendingRunActivation["runnerNotification"] {
  const payload = maintenanceJobPayload(launch);
  return {
    runnerGroup: payload.runnerGroup,
    runId: record.runId,
    profile: payload.profile,
    reuseKey: payload.reuseKey,
    cliAgentSessionId: payload.cliAgentSessionId,
    historyGenerationRunId: payload.historyGenerationRunId,
    createdAt: runnerJobCreatedAt,
  };
}
