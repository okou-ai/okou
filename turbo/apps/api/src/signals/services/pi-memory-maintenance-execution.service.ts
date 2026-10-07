import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import {
  getModelProviderFirewall,
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  DEFAULT_PROFILE,
  PI_MEMORY_ROOT,
  PI_SANDBOX_INSTALLED_CLI_MIN_VERSION,
  agentRunConnectorDiagnosticRegistrationPayloadSchema,
  type PiInstalledCliRequirement,
  type PiLaunchConfig,
  type PiModelConfig,
  type StoredExecutionContext,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import {
  canonicalizeFirewallBaseUrlVarsForExecution,
  extractSecretNamesFromApis,
  type ExecutionFirewallEntry,
} from "@okouai/connectors/firewall-types";
import {
  getAllFeatureStates,
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODEL_CONFIGS,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import type { PersistedStorageMount } from "@okouai/db/types";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { command, computed } from "ccstate";
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { safeSync, settle } from "../utils";
import { activatePendingRun$ } from "./agent-run-activation.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import type {
  AgentRunModelPin,
  PermissionManifest,
  ResolvedModelProviderEnvironment,
} from "./agent-run-contracts";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import {
  ApiDispatchPhaseCollector,
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import {
  prepareModelUsageContext,
  runRoutePricing,
  type BuiltInRoutePricing,
} from "./built-in-route-pricing";
import {
  collectPermissionNames,
  compactRecord,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";
import { createExecutionMemberMetadata } from "./execution-member-metadata.service";
import {
  createModelSourceSnapshot,
  type ModelSourceIdentity,
} from "./execution-model-source.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  createExecutionStorageObjects,
  updateExecutionStoragePresignedUrlCache$,
  type PreparedExecutionStorageMount,
} from "./execution-storage.service";
import {
  frameworkForProviderSelection,
  loadModelCatalog$,
  modelCatalogForOrg,
  type ModelCatalog,
} from "./model-catalog.service";
import { prepareRegisteredModelEnvironment } from "./model-provider.service";
import { readDisabledPaidTools } from "./paid-tools.service";
import {
  preparePiMemoryBuiltinEnvironment,
  readPiMemoryBuiltinPricing,
} from "./pi-memory-builtin-config";
import {
  materializePreparedPiProvider,
  resolvePlatformMemoryPiModelConfig,
  resolvePreparedPiModelConfig,
} from "./pi-sandbox-config";
import { normalizeMountOverlay } from "./storage-mount-overlay";

import { DISABLED_PAID_TOOLS_ENV_VAR } from "@okouai/api-contracts/contracts/paid-tools";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { expandVariables } from "@okouai/core/variable-expander";
import type { AgentRunFullLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentRunConnectorDiagnosticRegistrations } from "@okouai/db/schema/agent-run-connector-diagnostic-registration";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { and, eq, isNull } from "drizzle-orm";
import { parseRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { env, optionalEnv } from "../../lib/env";
import { isPiLangfuseDebugRunEnvironment } from "../../lib/pi-langfuse-debug";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { normalizeRunMetadata } from "./agent-run-metadata-write.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import { isPersonalSubscriptionProviderType } from "./model-provider-account.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import {
  allowanceSnapshotSchema,
  pendingRunAllowancePlan,
  pendingRunAllowanceWindowsPlan,
} from "./pending-launch-allowance-plan";
import { personalSubscriptionAccountIdentity } from "./personal-subscription-recovery.service";
import {
  PiMemoryPhase2CredentialError,
  resolvePiMemoryPhase2Credential,
} from "./pi-memory-phase2-credential.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import { bindPiMemoryPhase2MaintenanceRun } from "./pi-memory-phase2-maintenance.service";
import {
  PiMemoryQuotaError,
  checkPiMemoryQuota,
} from "./pi-memory-quota.service";
import {
  checkOrgCreditsForRunAdmission$,
  isFreePlanForCreditAdmission,
} from "./run-admission.service";
import {
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
  type RunContextAxiomSnapshot,
} from "./run-context-snapshot.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";
import { requireRunAllowanceWindowPair } from "./usage-allowance-run-plan";
import { entitlementQuery } from "./usage-allowance-settlement-plan";
import {
  createUsageAllowanceRefreshObject,
  type PreparedUsageAllowanceRefresh,
} from "./usage-allowance.service";

const log = logger("PiMemoryMaintenanceExecution");

const MAINTENANCE_PROMPT = "Run first-party Pi memory maintenance.";

const RESTRICTED_EXPLICIT_CONTENT_PROMPT = [
  "# Restricted Explicit Content",
  "",
  "Do not create, continue, rewrite, transform, or facilitate any of the following:",
  "- Pornography, explicit sexual acts, sexualized nudity, erotic roleplay, or other content intended for sexual arousal.",
  "- Any sexual depiction or sexualization of minors.",
  "- Graphic violence or gore, including detailed depictions of severe injury, torture, or dismemberment.",
  "- Instructions, methods, or encouragement for suicide or self-harm.",
  "",
  "These rules apply to direct responses and to files, prompts, code, links, or tool calls used to generate text, images, video, or audio, regardless of user or custom instructions.",
  "",
  "You may assist with non-graphic news, medical, educational, historical, safety, moderation, or ordinary fictional contexts. When a request crosses these boundaries, refuse briefly and offer a safe, non-explicit or non-graphic alternative.",
].join("\n");

function builtInImageModelPrompt(model: ImageModel): string {
  const alias = IMAGE_MODEL_CONFIGS[model].alias;
  return [
    "# Built-in image model",
    "",
    `Built-in image generation uses \`${alias}\`, from the user's image model setting in Settings › Built-in tools.`,
    "- The model cannot be changed per request. Do not pass `--model` to image generation commands.",
    "- If the user asks for a different built-in image model, tell them to change it in Settings › Built-in tools.",
    "- Image generation through a connected third-party service chooses its model separately; this setting does not apply to that path.",
  ].join("\n");
}

/** A claim that must be released with an explicit worker disposition. */
class PiMaintenanceDispositionError extends Error {
  constructor(readonly errorClass: string) {
    super(`Pi memory maintenance was not launched: ${errorClass}`);
    this.name = "PiMaintenanceDispositionError";
  }
}

type PiMaintenanceCredential = Awaited<
  ReturnType<typeof resolvePiMemoryPhase2Credential>
>;

function pinnedSourceIdentity(
  credential: PiMaintenanceCredential,
): ModelSourceIdentity {
  const { pin, route } = credential;
  if (pin.modelProvider === "built-in") {
    if (!route) {
      throw new PiMaintenanceDispositionError("model_route_unavailable");
    }
    return { kind: "built-in", modelKeyId: route.modelKeyId };
  }
  if (!pin.modelProviderId) {
    throw new PiMaintenanceDispositionError("credential_unavailable");
  }
  if (
    pin.modelProvider === "codex-oauth-token" &&
    pin.modelProviderCredentialScope === "member"
  ) {
    return { kind: "member", accountId: pin.modelProviderId };
  }
  throw new PiMaintenanceDispositionError("credential_unavailable");
}

function maintenancePayload(
  job: ClaimedPiMemoryPhase2Job,
  selectionDigest: string,
) {
  return {
    schemaVersion: 1,
    memoryStorageId: job.memoryStorageId,
    claimedRevision: job.claimedRevision,
    claimedBaseVersionId: job.baseVersion.versionId,
    leaseToken: job.leaseToken,
    selectionDigest,
    selected: job.selected.map((candidate) => {
      return {
        ...candidate,
        sourceCompletedAt: candidate.sourceCompletedAt.toISOString(),
      };
    }),
  } as const;
}

function maintenanceCallbackPayload(
  job: ClaimedPiMemoryPhase2Job,
  selectionDigest: string,
) {
  return {
    schemaVersion: 1,
    memoryStorageId: job.memoryStorageId,
    orgId: job.orgId,
    userId: job.userId,
    leaseToken: job.leaseToken,
    claimedRevision: job.claimedRevision,
    claimedBaseVersionId: job.baseVersion.versionId,
    selectionDigest,
    selected: job.selected.map((candidate) => {
      return {
        piSessionId: candidate.piSessionId,
        sourceHistoryHash: candidate.sourceHistoryHash,
      };
    }),
  };
}

interface MaintenanceAdmission {
  readonly featureSwitchContext: FeatureSwitchContext;
  readonly credential: PiMaintenanceCredential;
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly framework: NonNullable<
    ReturnType<typeof frameworkForProviderSelection>
  >;
}

/** Pi-owned admission: feature, current credential, credits and quota. */
const admitMaintenance$ = command(
  async (
    { set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<MaintenanceAdmission> => {
    const db = set(writeDb$);
    const featureSwitchContext = await set(
      loadUserFeatureSwitchContext$,
      job.orgId,
      job.userId,
      signal,
    );
    signal.throwIfAborted();
    if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, featureSwitchContext)) {
      throw new PiMaintenanceDispositionError("pi_memory_disabled");
    }
    const [globalCatalog, [org]] = await Promise.all([
      set(loadModelCatalog$, signal),
      db
        .select({ openrouterPreset: orgMetadata.openrouterPreset })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, job.orgId))
        .limit(1),
    ]);
    signal.throwIfAborted();
    const catalog = modelCatalogForOrg(globalCatalog, org?.openrouterPreset);
    const credential = await resolvePiMemoryPhase2Credential(
      catalog,
      db,
      job,
      signal,
    );
    signal.throwIfAborted();
    // Prepare ordinary credit admission first; quota then sees locally
    // reconciled usage. The final transaction remains authoritative.
    const admission = await set(
      checkOrgCreditsForRunAdmission$,
      {
        catalog,
        orgId: job.orgId,
        userId: job.userId,
        modelProviderType: credential.pin.modelProvider,
        selectedModel: credential.pin.selectedModel,
      },
      signal,
    );
    signal.throwIfAborted();
    if (admission) {
      throw new PiMaintenanceDispositionError("source_admission_denied");
    }
    await checkPiMemoryQuota(
      db,
      {
        orgId: job.orgId,
        userId: job.userId,
        stage: "phase2",
        source: credential.quota,
      },
      signal,
    );
    const selectedModel = credential.pin.selectedModel;
    // A pinned provider outside the current enum is unavailable, not a crash.
    const modelProviderType = modelProviderTypeSchema.safeParse(
      credential.pin.modelProvider,
    ).data;
    const framework =
      credential.pin.modelProvider === "built-in"
        ? ("codex" as const)
        : selectedModel && modelProviderType
          ? frameworkForProviderSelection(
              catalog,
              modelProviderType,
              selectedModel,
            )
          : null;
    if (!selectedModel || !framework) {
      throw new PiMaintenanceDispositionError("model_route_unavailable");
    }
    return {
      featureSwitchContext,
      credential,
      catalog,
      selectedModel,
      framework,
    };
  },
);

/** Exact pinned source → resolved runtime → Pi model configuration. */
async function prepareMaintenanceModel(
  admitted: MaintenanceAdmission,
  job: ClaimedPiMemoryPhase2Job,
  source: Parameters<typeof preparePiMemoryBuiltinEnvironment>[0],
) {
  const { catalog, credential, selectedModel } = admitted;
  const resolvedProvider: ResolvedModelProviderEnvironment | null =
    source.identity.kind === "built-in"
      ? preparePiMemoryBuiltinEnvironment(source, credential.route ?? undefined)
      : await prepareRegisteredModelEnvironment(source, selectedModel, {
          catalog,
          userId: job.userId,
          sourceId: credential.pin.modelProviderId ?? "",
          piExecution: true,
        });
  const piInput = { catalog, piExecution: true };
  const modelProvider = resolvedProvider
    ? credential.pin.modelProvider === "built-in"
      ? {
          ...resolvedProvider,
          piModelConfig: resolvePlatformMemoryPiModelConfig(resolvedProvider),
        }
      : materializePreparedPiProvider(piInput, resolvedProvider)
    : null;
  if (!modelProvider) {
    throw new PiMaintenanceDispositionError("credential_unavailable");
  }
  const piSandbox =
    credential.pin.modelProvider === "built-in"
      ? modelProvider.piModelConfig
      : resolvePreparedPiModelConfig({ input: piInput, modelProvider });
  if (!piSandbox) {
    throw new Error("Pi maintenance requires a Pi model configuration");
  }
  return { modelProvider, piSandbox };
}

/** The single exact memory writeback mount at the claimed base version. */
async function prepareMaintenanceStorage(
  job: ClaimedPiMemoryPhase2Job,
  preparedMounts: readonly PreparedExecutionStorageMount[],
  timing: ApiDispatchTimingCollector,
) {
  const artifact = {
    name: MEMORY_ARTIFACT_NAME,
    mountPath: PI_MEMORY_ROOT,
    version: job.baseVersion.versionId,
    missingRootPolicy: "fail" as const,
  };
  const [prepared] = preparedMounts;
  if (!prepared?.writeback || preparedMounts.length !== 1) {
    throw new Error("Pi maintenance expects exactly one prepared mount");
  }
  const storedMount: StoredStorageMountEntry = {
    orgId: prepared.orgId,
    userId: prepared.userId,
    storageId: prepared.storageId,
    versionId: prepared.versionId,
    name: prepared.name,
    mountPath: prepared.mountPath,
    writeback: true,
    ...(prepared.empty
      ? { empty: true }
      : {
          archiveUrl: prepared.archiveUrl,
          ...(prepared.archiveSize > 0
            ? { archiveSize: prepared.archiveSize }
            : {}),
        }),
    missingRootPolicy: prepared.missingRootPolicy,
  };
  const persistedMount: PersistedStorageMount = {
    orgId: job.orgId,
    userId: job.userId,
    name: artifact.name,
    storageId: job.baseVersion.storageId,
    version: job.baseVersion.versionId,
    mountPath: artifact.mountPath,
    writeback: true,
    missingRootPolicy: artifact.missingRootPolicy,
  };
  const storage = await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      return Promise.resolve({
        runContextStorage: {
          volumes: [],
          artifact: {
            mountPath: artifact.mountPath,
            vasStorageName: artifact.name,
            vasVersionId: job.baseVersion.versionId,
          },
        },
        storageMounts: normalizeMountOverlay([storedMount]),
        persistedStorageMounts: normalizeMountOverlay([persistedMount]),
      });
    },
  );
  return { artifact, storage };
}

/** The run's writeback mount, recorded on the session at the declared base. */
function maintenanceSessionStorageMounts(
  runStorageMounts: readonly PersistedStorageMount[],
  artifact: Awaited<ReturnType<typeof prepareMaintenanceStorage>>["artifact"],
): readonly PersistedStorageMount[] {
  return runStorageMounts.flatMap((mount) => {
    if (!mount.writeback) {
      return [];
    }
    if (
      mount.name !== artifact.name ||
      mount.mountPath !== artifact.mountPath
    ) {
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
        version: artifact.version,
        missingRootPolicy: artifact.missingRootPolicy,
      },
    ];
  });
}

const FIREWALL_BASE_URL_VAR_PATTERN =
  /\$\{\{\s*vars\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const DEFAULT_FIREWALL_SECRET_PLACEHOLDER =
  "c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe";

/** The model source's own firewall and network policy; no connectors. */
function maintenanceModelPermissionManifest(
  modelProvider: ResolvedModelProviderEnvironment,
): PermissionManifest | undefined {
  const firewall =
    modelProvider.firewall ??
    getModelProviderFirewall(modelProvider.concreteType ?? modelProvider.type);
  if (!firewall) {
    return undefined;
  }
  const entry = ((): ExecutionFirewallEntry => {
    // A name-only entry would lose the endpoint selected for this run.
    if (modelProvider.firewall !== undefined) {
      return { kind: "inline", firewall: runtimeFirewall(firewall) };
    }
    const usesBaseUrlVars = firewall.apis.some((api) => {
      return [...api.base.matchAll(FIREWALL_BASE_URL_VAR_PATTERN)].length > 0;
    });
    if (!usesBaseUrlVars) {
      return { kind: "builtin", name: firewall.name };
    }
    const baseUrlVars = canonicalizeFirewallBaseUrlVarsForExecution(
      [runtimeFirewall(firewall)],
      undefined,
    );
    return { kind: "builtin", name: firewall.name, baseUrlVars };
  })();
  const placeholders: Record<string, string> = {};
  for (const name of extractSecretNamesFromApis(firewall.apis)) {
    placeholders[name] = DEFAULT_FIREWALL_SECRET_PLACEHOLDER;
  }
  Object.assign(placeholders, firewall.placeholders);
  const permissionNames = collectPermissionNames(firewall.apis);
  const denySet = new Set(firewall.defaultPolicies?.deny ?? []);
  const askSet = new Set(firewall.defaultPolicies?.ask ?? []);
  return {
    firewalls: [entry],
    builtinRuntimeTargets: [],
    environmentSecretPlaceholders: compactRecord(placeholders),
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

/** Model firewall/permission manifest and usage pricing for the run. */
async function prepareMaintenanceUsage(args: {
  readonly db: ReadonlyDb;
  readonly resolution: Parameters<typeof runRoutePricing>[0]["resolution"];
  readonly catalog: MaintenanceAdmission["catalog"];
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly timing: ApiDispatchTimingCollector;
  readonly routePricing: BuiltInRoutePricing | null;
}) {
  const { catalog, modelProvider } = args;
  const permissionManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_model_provider_permission_policy",
    "nested",
    () => {
      return Promise.resolve(maintenanceModelPermissionManifest(modelProvider));
    },
  );
  const usage = prepareModelUsageContext({
    catalog,
    modelProvider,
    permissionManifest,
    routePricing: args.routePricing,
  });
  if ("kind" in usage) {
    throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
  }
  return { permissionManifest, usage };
}

/** Pi's own record of one maintenance run: identity, prompt and model. */
function maintenanceRunRecord(args: {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly runId: string;
  readonly apiStartTime: number;
  readonly selectionDigest: string;
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly credential: PiMaintenanceCredential;
  readonly storedImageModel: string | null | undefined;
}): MaintenanceRunRecord {
  const selectedImageModel = isImageModelId(args.storedImageModel)
    ? args.storedImageModel
    : DEFAULT_IMAGE_MODEL;
  return {
    runId: args.runId,
    sessionId: randomUUID(),
    orgId: args.job.orgId,
    userId: args.job.userId,
    apiStartTime: args.apiStartTime,
    prompt: MAINTENANCE_PROMPT,
    appendSystemPrompt: [
      builtInImageModelPrompt(selectedImageModel),
      RESTRICTED_EXPLICIT_CONTENT_PROMPT,
    ].join("\n\n"),
    launchSnapshot: {
      schemaVersion: 3,
      framework: "pi",
      runnerProfile: MAINTENANCE_RUNNER_PROFILE,
    },
    modelProvider: args.modelProvider,
    modelPin: args.credential.pin,
    selectedImageModel,
    callback: {
      internalKind: "pi-memory:phase2",
      payload: maintenanceCallbackPayload(args.job, args.selectionDigest),
    },
  };
}

interface MaintenanceLaunchInput {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly record: MaintenanceRunRecord;
  readonly selectionDigest: string;
  readonly piSandbox: Awaited<
    ReturnType<typeof prepareMaintenanceModel>
  >["piSandbox"];
  readonly permissionManifest: Awaited<
    ReturnType<typeof prepareMaintenanceUsage>
  >["permissionManifest"];
  readonly usage: Awaited<ReturnType<typeof prepareMaintenanceUsage>>["usage"];
  readonly disabledPaidTools: readonly string[];
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: MaintenanceAdmission["featureSwitchContext"];
  readonly timing: ApiDispatchTimingCollector;
  // Read in parallel with admission facts; a failed read fails this launch
  // preparation (and records the failed run) like any other storage step.
  readonly preparedMounts: Awaited<
    ReturnType<typeof settle<Parameters<typeof prepareMaintenanceStorage>[1]>>
  >;
}

/** Storage, encrypted model secrets and the Pi runner payload for one run. */
const prepareMaintenanceLaunch$ = command(
  async (
    { set },
    args: MaintenanceLaunchInput,
    signal: AbortSignal,
  ): Promise<MaintenanceLaunch> => {
    if (!args.preparedMounts.ok) {
      throw args.preparedMounts.error;
    }
    const runnerGroup = maintenanceRunnerGroup();
    const { artifact, storage } = await prepareMaintenanceStorage(
      args.job,
      args.preparedMounts.value,
      args.timing,
    );
    signal.throwIfAborted();
    const { record } = args;
    const encryptedSecrets = await set(
      encryptExecutionSecrets$,
      maintenanceExecutionSecrets(record.modelProvider).secrets,
      signal,
    );
    signal.throwIfAborted();
    const built = buildMaintenanceExecutionContext({
      modelProvider: record.modelProvider,
      permissionManifest: args.permissionManifest,
      usage: args.usage,
      encryptedSecrets,
      disabledPaidTools: args.disabledPaidTools,
      apiStartTime: record.apiStartTime,
      userTimezone: args.userTimezone,
      featureSwitchContext: args.featureSwitchContext,
      storageMounts: [...storage.storageMounts],
      pi: {
        modelConfig: args.piSandbox,
        maintenance: maintenancePayload(args.job, args.selectionDigest),
        sessionId: record.runId,
      },
    });
    const runStorageMounts = [...storage.persistedStorageMounts];
    return {
      ...built,
      runnerGroup,
      runStorageMounts,
      sessionStorageMounts: maintenanceSessionStorageMounts(
        runStorageMounts,
        artifact,
      ),
      runContextStorage: storage.runContextStorage,
    };
  },
);

/**
 * Launch preparation failed after admission: keep the failed run record (with
 * its callback row), re-validate the claim fence and bind nothing.
 */
async function failMaintenanceLaunch(
  db: Db,
  args: {
    readonly record: MaintenanceRunRecord;
    readonly credential: PiMaintenanceCredential;
    readonly error: unknown;
  },
  signal: AbortSignal,
): Promise<never> {
  await db.transaction(async (tx) => {
    await insertFailedMaintenanceRun(
      tx,
      args.record,
      args.error instanceof Error ? args.error.message : "Run failed",
    );
    await args.credential.validate(tx);
  });
  signal.throwIfAborted();
  throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
}

/** Atomic run + Runner job + job binding; the active-run row is last. */
interface MaintenanceCommitInput {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly credential: PiMaintenanceCredential;
  readonly selectionDigest: string;
  readonly record: MaintenanceRunRecord;
  readonly launch: MaintenanceLaunch;
  readonly allowanceRefresh: PreparedUsageAllowanceRefresh | undefined;
  readonly planCapabilities: OrgPlanCapabilities | null;
  readonly timing: ApiDispatchTimingCollector;
}

interface CommittedMaintenanceRun {
  readonly runnerJobCreatedAt: Date;
  readonly transactionReturnedAt: number;
  readonly admissionTiming: AdmissionAttemptTiming;
}

async function commitMaintenanceRun(
  db: Db,
  args: MaintenanceCommitInput,
): Promise<CommittedMaintenanceRun> {
  const { job, record } = args;
  const enforceBuiltInCredits = isBuiltInModelProviderType(
    record.modelProvider.type,
  );
  const admissionTiming = new AdmissionAttemptTiming({
    runId: record.runId,
    runnerGroup: args.launch.runnerGroup,
    profile: MAINTENANCE_RUNNER_PROFILE,
    dimensions: {},
    triggerSource: "agent",
  });
  const persisted = await db.transaction(async (tx) => {
    admissionTiming.transactionStarted();
    admissionTiming.admissionStarted();
    // Pi memory's ownership/version/credential fence, before any write.
    await args.credential.validate(tx);
    // A member subscription account is re-validated and its identity is
    // persisted on the run, as on every other run-creation path.
    const subscription = await validateMaintenanceSubscription(tx, record);
    if (!subscription) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    // Like Thread, Pi uses the captured plan without a launch-time plan lock.
    const capabilities = args.planCapabilities;
    const rows = await insertPendingMaintenanceRun(tx, {
      record,
      launch: args.launch,
      creditAdmitted:
        enforceBuiltInCredits &&
        isFreePlanForCreditAdmission(capabilities?.planKey),
      accountIdentity: subscription.identity,
    });
    await bindPiMemoryPhase2MaintenanceRun(tx, {
      runId: record.runId,
      binding: {
        memoryStorageId: job.memoryStorageId,
        orgId: job.orgId,
        userId: job.userId,
        leaseToken: job.leaseToken,
        claimedRevision: job.claimedRevision,
        claimedBaseVersionId: job.baseVersion.versionId,
        selectionDigest: args.selectionDigest,
      },
    });
    if (enforceBuiltInCredits) {
      const activation = {
        orgId: job.orgId,
        runId: record.runId,
        runCreatedAt: rows.createdAt,
        refresh: args.allowanceRefresh,
      };
      const [owned] = await tx.select().from(entitlementQuery(job.orgId));
      const planned = pendingRunAllowancePlan(owned, activation, nowDate());
      const [published] = planned.publication
        ? parseRawRows(
            allowanceSnapshotSchema,
            await tx.execute(planned.publication),
          )
        : [];
      const windows = pendingRunAllowanceWindowsPlan(
        planned,
        activation,
        published,
      );
      if (windows) {
        await tx.execute(windows.insert);
        requireRunAllowanceWindowPair(await tx.select().from(windows.windows));
      }
    }
    // The unique active-run insert stays the final statement.
    await tx.insert(activeAgentRuns).values({
      runId: record.runId,
      orgId: job.orgId,
      userId: job.userId,
      chatThreadId: null,
      lastHeartbeatAt: rows.createdAt,
    });
    admissionTiming.callbackFinished();
    return rows;
  });
  // Commit is creation success; nothing after this point rejects the claim.
  return {
    runnerJobCreatedAt: persisted.runnerJobCreatedAt,
    transactionReturnedAt: now(),
    admissionTiming,
  };
}

/** Post-commit dispatch bookkeeping for the committed run. */
async function finishCommittedMaintenanceRun(
  args: MaintenanceCommitInput,
  committed: CommittedMaintenanceRun,
): Promise<PendingRunActivation> {
  const { record } = args;
  const { transactionReturnedAt } = committed;
  await committed.admissionTiming.finish("pending");
  const phaseTiming = new ApiDispatchPhaseCollector(record.apiStartTime);
  phaseTiming.checkpoint(
    "api_dispatch_phase_queue_insert",
    committed.runnerJobCreatedAt.getTime(),
  );
  phaseTiming.checkpoint("api_dispatch_phase_commit", transactionReturnedAt);
  phaseTiming.appendTo(args.timing);
  ingestMaintenanceRunContext(record, args.launch);
  const runContextRegisteredAt = now();
  args.timing.flush({
    runId: record.runId,
    runnerGroup: args.launch.runnerGroup,
    profile: MAINTENANCE_RUNNER_PROFILE,
    dispatchPath: "direct",
    dimensions: {
      api_start_source: "request",
      run_preparation_retry_count: "0",
    },
    triggerSource: "agent",
  });
  return {
    apiStartTime: record.apiStartTime,
    chatThreadId: undefined,
    runnerNotification: maintenanceRunnerNotification(
      record,
      args.launch,
      committed.runnerJobCreatedAt,
    ),
    timing: {
      activationOrigin: "direct",
      commitReturnedAt: transactionReturnedAt,
      runContextRegisteredAt,
      dispatchTimingsRegisteredAt: now(),
    },
  };
}

/** The claimed job's exact memory base version, mounted for writeback. */
function maintenanceMemoryMount(job: ClaimedPiMemoryPhase2Job) {
  return {
    mode: "writeback" as const,
    orgId: job.orgId,
    userId: job.userId,
    storageId: job.baseVersion.storageId,
    versionId: job.baseVersion.versionId,
    name: MEMORY_ARTIFACT_NAME,
    mountPath: PI_MEMORY_ROOT,
    missingRootPolicy: "fail" as const,
  };
}

/**
 * The admitted job's model reads: the pinned source snapshot, its runtime
 * (side-effect-free decryption or managed-key read, Ethan 2026-10-02) and its
 * usage pricing and permissions, and the built-in allowance refresh read.
 * Built from plain values after admission.
 */
function createMaintenanceModelReads(
  job: ClaimedPiMemoryPhase2Job,
  admitted: MaintenanceAdmission,
  timing: ApiDispatchTimingCollector,
) {
  const source$ = createModelSourceSnapshot({
    orgId: job.orgId,
    userId: job.userId,
    source: pinnedSourceIdentity(admitted.credential),
  });
  const model$ = computed(async (get) => {
    const source = await get(source$);
    if (!source) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    return await prepareMaintenanceModel(admitted, job, source);
  });
  const usage$ = computed(async (get) => {
    const { modelProvider } = await get(model$);
    return await prepareMaintenanceUsage({
      db: get(db$),
      resolution: get(usagePricingResolution$),
      catalog: admitted.catalog,
      modelProvider,
      timing,
      routePricing:
        modelProvider.type === "built-in"
          ? await readPiMemoryBuiltinPricing(
              get(db$),
              admitted.catalog,
              get(usagePricingResolution$),
            )
          : await get(
              runRoutePricing({
                catalog: admitted.catalog,
                modelProvider,
                serviceTier: undefined,
                resolution: get(usagePricingResolution$),
              }),
            ),
    });
  });
  // For a built-in model, the Stripe entitlement read for the allowance window
  // (no write; the refresh itself is applied in the commit transaction).
  const preparedAllowanceRefresh$ = createUsageAllowanceRefreshObject(
    job.orgId,
  );
  const allowanceRefresh$ = computed(async (get) => {
    const { modelProvider } = await get(model$);
    return isBuiltInModelProviderType(modelProvider.type)
      ? await get(preparedAllowanceRefresh$)
      : undefined;
  });
  const planCapabilities$ = computed(async (get) => {
    const { modelProvider } = await get(model$);
    return isBuiltInModelProviderType(modelProvider.type)
      ? await loadOrgPlanCapabilities(get(db$), job.orgId)
      : null;
  });
  return { source$, model$, usage$, allowanceRefresh$, planCapabilities$ };
}

/**
 * One claimed job's read-only resources: the exact memory mount's storage
 * preparation, the member metadata and the disabled paid tools. Construction
 * builds computed reads only, so the launch command may build it per job.
 */
function createMaintenanceRunReads(job: ClaimedPiMemoryPhase2Job) {
  const owner = { orgId: job.orgId, userId: job.userId };
  const memoryMounts = [maintenanceMemoryMount(job)];
  return {
    owner,
    memoryMounts,
    storage: createExecutionStorageObjects(memoryMounts),
    member$: createExecutionMemberMetadata(owner),
    disabledPaidTools$: computed(async (get): Promise<readonly string[]> => {
      return await readDisabledPaidTools(get(db$), job.orgId, job.userId);
    }),
  };
}

/**
 * Activates a committed run. An abort still propagates, but any other failure
 * is logged and never rejects: a committed execution is never reported as a
 * no-run.
 */
const activateCommittedMaintenanceRun$ = command(
  async (
    { set },
    commitInput: MaintenanceCommitInput,
    committed: CommittedMaintenanceRun,
    signal: AbortSignal,
  ): Promise<void> => {
    const activated = await settle(
      (async () => {
        const activation = await finishCommittedMaintenanceRun(
          commitInput,
          committed,
        );
        signal.throwIfAborted();
        await set(
          activatePendingRun$,
          {
            notification: activation.runnerNotification,
            timing: activation.timing,
            activationScheduledAt: now(),
          },
          signal,
        );
      })(),
      signal,
    );
    if (!activated.ok) {
      log.error("Pi maintenance run activation failed after commit", {
        runId: commitInput.record.runId,
        error: activated.error,
      });
    }
  },
);

/**
 * Launch one claimed job: admit it (which may refresh a subscription),
 * prepare the exact memory mount, the pinned model and the Pi launch,
 * atomically commit the run with its job binding, then activate it and write
 * the presigned URL cache. The pinned source is known only after admission;
 * its snapshot is a pure computed read.
 */
const launchMaintenanceRun$ = command(
  async (
    { get, set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<string> => {
    const { memoryMounts, storage, member$, disabledPaidTools$ } =
      createMaintenanceRunReads(job);
    const db = set(writeDb$);
    const apiStartTime = now();
    const admitted = await set(admitMaintenance$, job, signal);
    const timing = new ApiDispatchTimingCollector();
    const modelReads = createMaintenanceModelReads(job, admitted, timing);
    const [source, member, disabledPaidTools, preparedMounts] =
      await Promise.all([
        get(modelReads.source$),
        get(member$),
        get(disabledPaidTools$),
        settle(get(storage.preparedMounts$), signal),
      ]);
    signal.throwIfAborted();
    if (!source) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    const [{ modelProvider, piSandbox }, { permissionManifest, usage }] =
      await Promise.all([get(modelReads.model$), get(modelReads.usage$)]);
    signal.throwIfAborted();
    const selectionDigest = piMemoryPhase2SelectionDigest(job.selected);
    const record = maintenanceRunRecord({
      job,
      runId: randomUUID(),
      apiStartTime,
      selectionDigest,
      modelProvider,
      credential: admitted.credential,
      storedImageModel: member.preferences?.selectedImageModel,
    });
    // Launch preparation and the built-in allowance refresh read run
    // together outside the transaction; either failure records the failed run.
    const prepared = await settle(
      Promise.all([
        set(
          prepareMaintenanceLaunch$,
          {
            job,
            record,
            selectionDigest,
            piSandbox,
            permissionManifest,
            usage,
            disabledPaidTools,
            userTimezone: member.preferences?.timezone ?? undefined,
            featureSwitchContext: admitted.featureSwitchContext,
            timing,
            preparedMounts,
          },
          signal,
        ),
        get(modelReads.allowanceRefresh$),
        get(modelReads.planCapabilities$),
      ]),
      signal,
    );
    if (!prepared.ok) {
      return await failMaintenanceLaunch(
        db,
        { record, credential: admitted.credential, error: prepared.error },
        signal,
      );
    }
    const [launch, allowanceRefresh, planCapabilities] = prepared.value;
    const commitInput = {
      job,
      credential: admitted.credential,
      selectionDigest,
      record,
      launch,
      allowanceRefresh,
      planCapabilities,
      timing,
    };
    const committed = await commitMaintenanceRun(db, commitInput);
    signal.throwIfAborted();
    await set(activateCommittedMaintenanceRun$, commitInput, committed, signal);
    // The approved log-only presigned URL cache write, after commit.
    if (preparedMounts.ok) {
      const cache = await settle(
        set(
          updateExecutionStoragePresignedUrlCache$,
          memoryMounts,
          preparedMounts.value,
          signal,
        ),
        signal,
      );
      if (!cache.ok) {
        log.warn("Pi maintenance presigned URL cache update failed", {
          runId: record.runId,
        });
      }
    }
    return record.runId;
  },
);

/** An explicit worker disposition for a claim that launched nothing. */
interface MaintenanceDisposition {
  readonly errorClass: string;
}

/**
 * Launch one claimed Pi Phase 2 job. Returns the committed run id, or the
 * disposition data for a normal no-launch (admission, credential, quota or
 * launch-preparation outcome). Unexpected errors reject.
 */
export const startMaintenanceRun$ = command(
  async (
    { set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<string | MaintenanceDisposition> => {
    const launched = await settle(
      set(launchMaintenanceRun$, job, signal),
      signal,
    );
    if (launched.ok) {
      return launched.value;
    }
    if (
      launched.error instanceof PiMaintenanceDispositionError ||
      launched.error instanceof PiMemoryPhase2CredentialError ||
      launched.error instanceof PiMemoryQuotaError
    ) {
      return { errorClass: launched.error.errorClass };
    }
    throw launched.error;
  },
);

/**
 * The Runner protocol routes every job to an executor group and profile. A
 * maintenance run has no Agent to override them, so it uses the deployment's
 * default executor group and the default profile.
 */
function maintenanceRunnerGroup(): string {
  const group = optionalEnv("RUNNER_DEFAULT_GROUP");
  if (!group) {
    throw new Error("No executor configured: set RUNNER_DEFAULT_GROUP");
  }
  if (group.split("/")[0] !== "vm0") {
    throw new Error("Only vm0/* runner groups are supported");
  }
  return group;
}

const MAINTENANCE_RUNNER_PROFILE = DEFAULT_PROFILE;

function compact<T>(
  values: Readonly<Record<string, T>> | undefined,
): Record<string, T> | undefined {
  return values && Object.keys(values).length > 0 ? { ...values } : undefined;
}

/** The model source's runtime `secrets.NAME` namespace and access metadata. */
function maintenanceExecutionSecrets(
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
interface MaintenancePiLaunch {
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
function buildMaintenanceExecutionContext(
  args: MaintenanceExecutionContextInput,
) {
  const permissions = args.permissionManifest;
  const executionSecrets = maintenanceExecutionSecrets(args.modelProvider);
  const platformEnvironment = {
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(args.disabledPaidTools),
    CLI_PKG_URL: env("CLI_PKG_URL"),
  };
  const modelEnvironment = maintenanceModelEnvironment({
    modelProvider: args.modelProvider,
    secrets: executionSecrets.secrets,
    placeholders: permissions?.environmentSecretPlaceholders,
  });
  const environment = modelEnvironment;
  const effectiveEnvironment = { ...environment, ...platformEnvironment };
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
interface MaintenanceRunRecord {
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
async function validateMaintenanceSubscription(
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
  if (!provider.id) {
    return null;
  }
  const [account] = await tx
    .select()
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.id, provider.id),
        eq(modelProviderAccounts.orgId, record.orgId),
        eq(modelProviderAccounts.userId, record.userId),
        isNull(modelProviderAccounts.disconnectedAt),
        eq(modelProviderAccounts.type, provider.type),
      ),
    )
    .limit(1);
  return account
    ? { identity: personalSubscriptionAccountIdentity(account) }
    : null;
}

/** The failed run record with its callback row; no Runner job. */
async function insertFailedMaintenanceRun(
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

interface MaintenanceLaunch {
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
async function insertPendingMaintenanceRun(
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
function ingestMaintenanceRunContext(
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
function maintenanceRunnerNotification(
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
