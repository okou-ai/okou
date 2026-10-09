import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { getModelProviderFirewall } from "@okouai/api-contracts/contracts/model-providers";
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
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import type { PersistedStorageMount } from "@okouai/db/types";
import {
  piMemoryPhase2SelectionDigest,
  piMemorySessionAffinityKey,
} from "@okouai/pi-agent-runtime/api";
import { command } from "ccstate";
import { randomUUID } from "node:crypto";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
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
  collectPermissionNames,
  compactRecord,
  runtimeFirewall,
} from "./connector-runtime-preparation.service";
import { readExecutionMemberMetadata$ } from "./execution-member-metadata.service";
import {
  readModelSourceSnapshot$,
  type ModelSourceIdentity,
} from "./execution-model-source.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  prepareExecutionStorageMounts$,
  updateExecutionStoragePresignedUrlCache$,
  type PreparedExecutionStorageMount,
} from "./execution-storage.service";
import { readDisabledPaidTools$ } from "./paid-tools.service";
import { preparePiMemoryBuiltinEnvironment } from "./pi-memory-builtin-config";
import { resolvePlatformMemoryPiModelConfig } from "./pi-sandbox-config";
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
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { storages } from "@okouai/db/schema/storage";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import {
  PI_AGENT_RUNTIME_VERSION,
  PI_SESSION_CONSTRUCTION_DIGEST,
} from "@okouai/pi-agent-runtime";
import { env, optionalEnv } from "../../lib/env";
import { piModelConfigObservation } from "../../lib/pi-model-config-observation";
import { getDatasetName, ingestToAxiom } from "../external/axiom";
import { normalizeRunMetadata } from "./agent-run-metadata-write.service";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import { historyGenerationRunIdForStoredExecutionContext } from "./history-generation-run";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import {
  PiMemoryPhase2CredentialError,
  resolvePiMemoryPhase2Credential$,
  piMemoryPhase2CredentialValidationPlan,
  piMemoryPhase2FeatureContext,
  requirePiMemoryPhase2FeatureEnabled,
  requirePiMemoryPhase2CredentialStorage,
} from "./pi-memory-phase2-credential.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import { piMemoryPhase2MaintenanceBindingCondition } from "./pi-memory-phase2-maintenance.service";
import {
  environmentRecordToEntries,
  executionFirewallsToAxiomEntries,
  featureFlagsRecordToEntries,
  networkPoliciesRecordToEntries,
  type RunContextAxiomSnapshot,
} from "./run-context-snapshot.service";
import { runnerJobQueueTimestamps } from "./runner-job-queue-lifecycle.service";

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
  ReturnType<typeof resolvePiMemoryPhase2Credential$.write>
>;

function pinnedSourceIdentity(
  credential: PiMaintenanceCredential,
): ModelSourceIdentity {
  return { kind: "built-in", modelKeyId: credential.route.modelKeyId };
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
}

/** Pi-owned admission: feature and platform credential, independent of credits. */
const admitMaintenance$ = command(
  async (
    { set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<MaintenanceAdmission> => {
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
    const credential = await set(resolvePiMemoryPhase2Credential$, job, signal);
    signal.throwIfAborted();
    return { featureSwitchContext, credential };
  },
);

/** Exact pinned source → resolved runtime → Pi model configuration. */
const prepareMaintenanceModel$ = command(
  async (
    { set },
    args: {
      readonly route: PiMaintenanceCredential["route"];
      readonly job: ClaimedPiMemoryPhase2Job;
      readonly source: Parameters<typeof preparePiMemoryBuiltinEnvironment>[0];
      readonly timing: ApiDispatchTimingCollector;
    },
  ) => {
    const { route, job, source } = args;
    const resolvedProvider = preparePiMemoryBuiltinEnvironment(source, route);
    if (!resolvedProvider) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    const piSandbox = resolvePlatformMemoryPiModelConfig(resolvedProvider);
    const modelProvider = {
      ...resolvedProvider,
      environment: {
        ...resolvedProvider.environment,
        OKOU_MEMORY_SESSION_ID: piMemorySessionAffinityKey(
          job.userId,
          job.orgId,
        ),
      },
      piModelConfig: piSandbox,
    };
    const preparedUsage = await set(prepareMaintenanceUsage$, {
      modelProvider,
      timing: args.timing,
    });
    return { modelProvider, piSandbox, ...preparedUsage };
  },
);
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
  const firewall = getModelProviderFirewall(
    modelProvider.concreteType ?? modelProvider.type,
  );
  if (!firewall) {
    return undefined;
  }
  const entry = ((): ExecutionFirewallEntry => {
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

/** Model access remains firewalled; memory captures no billable usage. */
async function prepareMaintenanceUsage(args: {
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly timing: ApiDispatchTimingCollector;
}) {
  const { modelProvider } = args;
  const permissionManifest = await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_context_apply_model_provider_permission_policy",
    "nested",
    () => {
      return Promise.resolve(maintenanceModelPermissionManifest(modelProvider));
    },
  );
  // Model access still has the ordinary firewall/credential policy, but no
  // billable flow or pricing identity is captured for free maintenance.
  return {
    permissionManifest,
    usage: {
      billableFirewalls: [],
      modelUsageProvider: undefined,
      modelUsageLongContextMinTotalInputTokens: 0,
    },
  };
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
    ReturnType<typeof prepareMaintenanceModel$.write>
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
const failMaintenanceLaunch$ = command(
  async (
    { set },
    args: {
      readonly record: MaintenanceRunRecord;
      readonly credential: PiMaintenanceCredential;
      readonly error: unknown;
    },
    signal: AbortSignal,
  ): Promise<never> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const { record } = args;
      const error =
        args.error instanceof Error ? args.error.message : "Run failed";
      const rowInput = {
        record,
        createdAt: nowDate(),
        status: "failed" as const,
        runStorageMounts: null,
        sessionStorageMounts: null,
        runnerGroup: null,
        creditAdmitted: false,
        accountIdentity: null,
        error,
      };
      await tx
        .insert(agentSessions)
        .values(
          maintenanceSessionValues(record, rowInput.sessionStorageMounts),
        );
      await tx.insert(agentRuns).values(maintenanceRunValues(rowInput));
      await tx
        .insert(agentRunCallbacks)
        .values(maintenanceCallbackValues(record));
      const capture = maintenanceBillingAttribution(record, rowInput.createdAt);
      const [attribution] = await tx
        .insert(billingRunAttribution)
        .values(capture.values)
        .onConflictDoUpdate(capture.conflict)
        .returning({ id: billingRunAttribution.runId });
      if (!attribution) {
        throw new Error("New Run billing attribution conflicts with history");
      }
      signal.throwIfAborted();
      const proof = args.credential.proof;
      // Preserve the storage and feature fences for the captured owner.
      const plan = piMemoryPhase2CredentialValidationPlan(proof);
      const [storage] = await tx
        .select(plan.storage.fields)
        .from(storages)
        .where(plan.storage.where)
        .for("share");
      requirePiMemoryPhase2CredentialStorage(storage);
      const featureRows = await tx
        .select(plan.features.fields)
        .from(userFeatureSwitches)
        .where(plan.features.where);
      const context = piMemoryPhase2FeatureContext(proof, featureRows);
      signal.throwIfAborted();
      requirePiMemoryPhase2FeatureEnabled(context);
    });
    signal.throwIfAborted();
    throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
  },
);

/** Atomic run + Runner job + job binding; the active-run row is last. */
interface MaintenanceCommitInput {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly credential: PiMaintenanceCredential;
  readonly selectionDigest: string;
  readonly record: MaintenanceRunRecord;
  readonly launch: MaintenanceLaunch;
  readonly timing: ApiDispatchTimingCollector;
}

interface CommittedMaintenanceRun {
  readonly runnerJobCreatedAt: Date;
  readonly transactionReturnedAt: number;
  readonly admissionTiming: AdmissionAttemptTiming;
}

const persistMaintenanceRun$ = command(
  (
    { set },
    args: MaintenanceCommitInput,
    signal: AbortSignal,
  ): Promise<Omit<CommittedMaintenanceRun, "transactionReturnedAt">> => {
    const db = set(writeDb$);
    const { record } = args;
    const admissionTiming = maintenanceAdmissionTiming(args);
    return db.transaction(async (tx) => {
      admissionTiming.transactionStarted();
      admissionTiming.admissionStarted();
      // Pi memory's ownership/version/credential fence, before any write.
      signal.throwIfAborted();
      const proof = args.credential.proof;
      const plan = piMemoryPhase2CredentialValidationPlan(proof);
      const [storage] = await tx
        .select(plan.storage.fields)
        .from(storages)
        .where(plan.storage.where)
        .for("share");
      requirePiMemoryPhase2CredentialStorage(storage);
      const featureRows = await tx
        .select(plan.features.fields)
        .from(userFeatureSwitches)
        .where(plan.features.where);
      const context = piMemoryPhase2FeatureContext(proof, featureRows);
      signal.throwIfAborted();
      requirePiMemoryPhase2FeatureEnabled(context);
      const createdAt = nowDate();
      const rowInput = maintenancePendingRunInput(args, createdAt);
      await tx.insert(agentSessions).values(rowInput.session);
      await tx.insert(agentRuns).values(maintenanceRunValues(rowInput));
      await tx.insert(agentRunCallbacks).values(rowInput.callback);
      const capture = maintenanceBillingAttribution(record, rowInput.createdAt);
      const [attribution] = await tx
        .insert(billingRunAttribution)
        .values(capture.values)
        .onConflictDoUpdate(capture.conflict)
        .returning({ id: billingRunAttribution.runId });
      if (!attribution) {
        throw new Error("New Run billing attribution conflicts with history");
      }
      const diagnostic = maintenanceDiagnosticValues(
        record,
        args.launch,
        createdAt,
      );
      await tx
        .insert(agentRunConnectorDiagnosticRegistrations)
        .values(diagnostic);
      const payload = maintenanceJobPayload(args.launch);
      const runnerValues = maintenanceRunnerJobValues(
        record,
        payload,
        runnerJobQueueTimestamps(),
      );
      const [runnerJob] = await tx
        .insert(runnerJobQueue)
        .values(runnerValues)
        .returning({ createdAt: runnerJobQueue.createdAt });
      if (!runnerJob) {
        throw new Error("Pi maintenance Runner job was not persisted");
      }
      // Bind the run before this transaction makes its Runner job visible.
      const binding = maintenanceBindingPlan(args, nowDate(), nowDate());
      const [bound] = await tx
        .update(piMemoryPhase2Jobs)
        .set(binding.values)
        .where(binding.where)
        .returning({ memoryStorageId: piMemoryPhase2Jobs.memoryStorageId });
      if (!bound) {
        throw new Error(
          "Pi memory Phase 2 maintenance run lost its claim fence",
        );
      }
      // The unique active-run insert stays the final statement.
      await tx
        .insert(activeAgentRuns)
        .values(maintenanceActiveRunValues(args, createdAt));
      admissionTiming.callbackFinished();
      return { runnerJobCreatedAt: runnerJob.createdAt, admissionTiming };
    });
  },
);

/** Sample the return clock after COMMIT, before the caller's existing cancellation gate. */
const commitMaintenanceRun$ = command(
  async (
    { set },
    args: MaintenanceCommitInput,
    signal: AbortSignal,
  ): Promise<CommittedMaintenanceRun> => {
    const persisted = await set(persistMaintenanceRun$, args, signal);
    return { ...persisted, transactionReturnedAt: now() };
  },
);

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

/** Free memory has no pricing lookup or billable firewall capture. */
const prepareMaintenanceUsage$ = command(
  async (
    _,
    args: Pick<
      Parameters<typeof prepareMaintenanceUsage>[0],
      "modelProvider" | "timing"
    >,
  ) => {
    return await prepareMaintenanceUsage(args);
  },
);

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
 * Launch one claimed job: admit its platform credential,
 * prepare the exact memory mount, the pinned model and the Pi launch,
 * atomically commit the run with its job binding, then activate it and write
 * the presigned URL cache. The pinned source is known only after admission;
 * fixed commands capture its source and the exact launch read snapshots.
 */
const launchMaintenanceRun$ = command(
  async (
    { set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<string> => {
    const owner = { orgId: job.orgId, userId: job.userId };
    const memoryMounts = [maintenanceMemoryMount(job)];
    const apiStartTime = now();
    const admitted = await set(admitMaintenance$, job, signal);
    const timing = new ApiDispatchTimingCollector();
    const [source, member, disabledPaidTools, preparedMounts] =
      await Promise.all([
        set(readModelSourceSnapshot$, {
          ...owner,
          source: pinnedSourceIdentity(admitted.credential),
        }),
        set(readExecutionMemberMetadata$, owner),
        set(readDisabledPaidTools$, owner),
        settle(set(prepareExecutionStorageMounts$, memoryMounts), signal),
      ]);
    signal.throwIfAborted();
    if (!source) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    const { modelProvider, piSandbox, permissionManifest, usage } = await set(
      prepareMaintenanceModel$,
      {
        job,
        source,
        route: admitted.credential.route,
        timing,
      },
    );
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
    // Free memory prepares no member allowance or credit admission.
    const prepared = await settle(
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
      signal,
    );
    if (!prepared.ok) {
      return await set(
        failMaintenanceLaunch$,
        { record, credential: admitted.credential, error: prepared.error },
        signal,
      );
    }
    const launch = prepared.value;
    const commitInput = {
      job,
      credential: admitted.credential,
      selectionDigest,
      record,
      launch,
      timing,
    };
    const committed = await set(commitMaintenanceRun$, commitInput, signal);
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
      launched.error instanceof PiMemoryPhase2CredentialError
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
  const memorySessionId = args.modelProvider.environment.OKOU_MEMORY_SESSION_ID;
  if (!memorySessionId) {
    throw new Error("Missing memory owner session affinity");
  }
  const platformEnvironment = {
    [DISABLED_PAID_TOOLS_ENV_VAR]: JSON.stringify(args.disabledPaidTools),
    CLI_PKG_URL: env("CLI_PKG_URL"),
    OKOU_MEMORY_SESSION_ID: memorySessionId,
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
  const route = record.modelProvider.builtInModelRuntimeRoute;
  return normalizeRunMetadata({
    // Maintenance runs are agent-triggered, as on every earlier release.
    triggerSource: "agent",
    modelProvider: record.modelPin.modelProvider,
    modelProviderId: record.modelPin.modelProviderId,
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
    officialWorkflowProvenance: null,
    completedAt: args.status === "failed" ? args.createdAt : null,
    error: args.error,
    modelProviderAccountIdentity: args.accountIdentity,
    ...maintenanceRunMetadata(record),
  };
}

function maintenanceSessionValues(
  record: MaintenanceRunRecord,
  storageMounts: readonly PersistedStorageMount[] | null,
) {
  return {
    id: record.sessionId,
    userId: record.userId,
    orgId: record.orgId,
    agentId: null,
    storageMounts: storageMounts ? [...storageMounts] : null,
    conversationId: null,
  };
}

function maintenanceCallbackValues(record: MaintenanceRunRecord) {
  return {
    runId: record.runId,
    url: null,
    internalKind: record.callback.internalKind,
    encryptedSecret: null,
    payload: record.callback.payload,
  };
}

function maintenanceBillingAttribution(
  record: MaintenanceRunRecord,
  createdAt: Date,
) {
  return billingRunAttributionWrite({
    id: record.runId,
    orgId: record.orgId,
    userId: record.userId,
    startedAt: createdAt.toISOString(),
    triggerSource: "agent",
    threadId: null,
  });
}

function maintenanceDiagnosticValues(
  record: MaintenanceRunRecord,
  launch: MaintenanceLaunch,
  createdAt: Date,
) {
  return {
    runId: record.runId,
    payload: agentRunConnectorDiagnosticRegistrationPayloadSchema.parse({
      version: 1,
      targets: launch.context.connectorRuntimeTargets,
    }),
    createdAt,
  };
}

function maintenanceRunnerJobValues(
  record: MaintenanceRunRecord,
  payload: ReturnType<typeof maintenanceJobPayload>,
  timestamps: ReturnType<typeof runnerJobQueueTimestamps>,
) {
  return {
    runId: record.runId,
    runnerGroup: payload.runnerGroup,
    profile: payload.profile,
    cliAgentSessionId: payload.cliAgentSessionId,
    reuseKey: payload.reuseKey,
    executionContext: payload.executionContext,
    ...timestamps,
  };
}

function maintenanceAdmissionTiming(args: MaintenanceCommitInput) {
  return new AdmissionAttemptTiming({
    runId: args.record.runId,
    runnerGroup: args.launch.runnerGroup,
    profile: MAINTENANCE_RUNNER_PROFILE,
    dimensions: {},
    triggerSource: "agent",
  });
}

function maintenanceActiveRunValues(
  args: MaintenanceCommitInput,
  createdAt: Date,
) {
  return {
    runId: args.record.runId,
    orgId: args.job.orgId,
    userId: args.job.userId,
    chatThreadId: null,
    lastHeartbeatAt: createdAt,
  };
}

function maintenancePendingRunInput(
  args: MaintenanceCommitInput,
  createdAt: Date,
) {
  return {
    record: args.record,
    session: maintenanceSessionValues(
      args.record,
      args.launch.sessionStorageMounts,
    ),
    callback: maintenanceCallbackValues(args.record),
    createdAt,
    status: "pending" as const,
    runStorageMounts: args.launch.runStorageMounts,
    runnerGroup: args.launch.runnerGroup,
    creditAdmitted: false,
    accountIdentity: null,
    error: null,
  };
}

function maintenanceBindingPlan(
  args: MaintenanceCommitInput,
  updatedAt: Date,
  fenceAt: Date,
) {
  return {
    values: { maintenanceRunId: args.record.runId, updatedAt },
    where: piMemoryPhase2MaintenanceBindingCondition(
      maintenanceBindingInput(args),
      fenceAt,
    ),
  };
}

function maintenanceBindingInput(args: MaintenanceCommitInput) {
  const { job } = args;
  return {
    binding: {
      memoryStorageId: job.memoryStorageId,
      orgId: job.orgId,
      userId: job.userId,
      leaseToken: job.leaseToken,
      claimedRevision: job.claimedRevision,
      claimedBaseVersionId: job.baseVersion.versionId,
      selectionDigest: args.selectionDigest,
    },
  };
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
