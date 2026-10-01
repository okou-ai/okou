import { randomUUID } from "node:crypto";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { billingRunAttributionWrite } from "./managed-usage-attribution";
import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import type { AgentRunFullLaunchSnapshot } from "@okouai/db/jsonb-contracts/agent-run-session-conversation";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { now, nowDate } from "../../lib/time";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import {
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import { activatePendingRun$ } from "./agent-run-activation.service";
import { createExecutionMemberMetadata } from "./execution-member-metadata.service";
import { createAgentDisabledPaidTools } from "./agent-bootstrap-resources";
import {
  createModelSourceSnapshot,
  type ModelSourceIdentity,
} from "./execution-model-source.service";
import {
  prepareGatewayModelEnvironment,
  prepareManagedModelEnvironment,
  prepareRegisteredModelEnvironment,
} from "./execution-model-preparation.service";
import { createExecutionStorageObjects } from "./execution-storage.service";
import {
  AUTO_MEMORY_ARTIFACT_NAME,
  finalizePreparedStorage,
  storedMountFromPrepared,
  writebackStorageEntryMetadata,
} from "./execution-storage-manifest.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  assembleRunnerLaunch,
  buildPreparedPermissionManifest,
  buildStoredExecutionContextDraft,
  buildStoredExecutionSecrets,
  preparedRunnerGroup,
  runnerProfile,
  withPaidToolPlatformEnvironment,
} from "./execution-runner-payload.service";
import {
  frameworkForProviderSelection,
  loadRunRoutePricing,
  materializePreparedPiProvider,
  prepareModelUsageContext,
  resolvePreparedPiModelConfig,
} from "./run-model-provider-environment.service";
import { assemblePiLaunchResources } from "./pi-launch-resources.service";
import { emptyCustomConnectorRuntimeContext } from "./run-connector-context.service";
import {
  buildAtomicLaunchCteContext,
  committedAtomicLaunchResponse,
  persistPendingAtomicLaunch,
  prepareAtomicLaunchPersistence,
  validateCapturedSubscriptionAccount,
  launchRunMetadataValues,
  launchRunValues,
  launchSessionValues,
  type CommitPreparedLaunchArgs,
  type LaunchRunRowsArgs,
  type CreateRunBody,
  type PreparedCommitPreparedLaunchArgs,
  type ResolvedModelProviderEnvironment,
} from "./execution-launch-persistence.service";
import { isRouteError } from "./run-execution-body.service";
import { admissionAttemptOutcome } from "./execution-launch-admission.service";

import { withFinalRunAppendSystemPrompt } from "./run-execution-context.service";
import { loadModelCatalog } from "./model-catalog.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  activateUsageAllowanceWindowsForRun,
  type PreparedUsageAllowanceRefresh,
  prepareUsageAllowanceRefresh$,
} from "./usage-allowance.service";
import {
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  checkOrgCreditsForRunAdmission,
  isFreePlanForCreditAdmission,
} from "./run-admission.service";
import { checkPiMemoryQuota } from "./pi-memory-quota.service";
import { resolvePiMemoryPhase2Credential } from "./pi-memory-phase2-credential.service";
import { bindPiMemoryPhase2MaintenanceRun } from "./pi-memory-phase2-maintenance.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";
import { settle } from "../utils";
import { logger } from "../../lib/log";

const log = logger("PiMemoryMaintenanceExecution");

const MAINTENANCE_PROMPT = "Run first-party Pi memory maintenance.";

/** A claim that must be released with an explicit worker disposition. */
export class PiMaintenanceDispositionError extends Error {
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
  if (pin.modelProvider === "custom-openai-responses") {
    return { kind: "gateway", surfaceId: pin.modelProviderId };
  }
  if (pin.modelProvider === "codex-oauth-token") {
    return pin.modelProviderCredentialScope === "org"
      ? { kind: "organization", modelProviderId: pin.modelProviderId }
      : { kind: "member", accountId: pin.modelProviderId };
  }
  return pin.modelProviderCredentialScope === "member"
    ? { kind: "member-provider", modelProviderId: pin.modelProviderId }
    : { kind: "organization", modelProviderId: pin.modelProviderId };
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

function emptyBuiltinConnectorContext() {
  return {
    secrets: undefined,
    vars: undefined,
    secretConnectorMap: undefined,
    secretConnectorMetadataMap: undefined,
    connectorSlugs: [],
    mcpConnectorSlugs: [],
    connectorSourceIdBySlug: {},
    storedEnvironment: undefined,
  };
}

const MAINTENANCE_CONTENT = {
  version: "1",
  agent: { framework: "claude-code" },
} as const;

/** Pi-owned admission: feature, current credential, credits and quota. */
async function admitMaintenance(
  db: Db,
  job: ClaimedPiMemoryPhase2Job,
  signal: AbortSignal,
) {
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    job.orgId,
    job.userId,
  );
  signal.throwIfAborted();
  if (!isFeatureEnabled(FeatureSwitchKey.PiMemory, featureSwitchContext)) {
    throw new PiMaintenanceDispositionError("pi_memory_disabled");
  }
  const credential = await resolvePiMemoryPhase2Credential(db, job, signal);
  const catalog = await loadModelCatalog(db);
  signal.throwIfAborted();
  // Prepare ordinary credit admission first; quota then sees locally
  // reconciled usage. The final transaction remains authoritative.
  const admission = await checkOrgCreditsForRunAdmission({
    db,
    catalog,
    orgId: job.orgId,
    userId: job.userId,
    modelProviderType: credential.pin.modelProvider,
    selectedModel: credential.pin.selectedModel,
  });
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
  const modelProviderType = modelProviderTypeSchema.parse(
    credential.pin.modelProvider,
  );
  const framework = selectedModel
    ? frameworkForProviderSelection(catalog, modelProviderType, selectedModel)
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
}
type MaintenanceAdmission = Awaited<ReturnType<typeof admitMaintenance>>;

/** Exact pinned source → effect-resolved runtime → Pi model configuration. */
async function prepareMaintenanceModel(
  db: Db,
  admitted: MaintenanceAdmission,
  job: ClaimedPiMemoryPhase2Job,
  source: Parameters<typeof prepareManagedModelEnvironment>[1],
  signal: AbortSignal,
) {
  const { catalog, credential, selectedModel, framework } = admitted;
  const resolvedProvider: ResolvedModelProviderEnvironment | null =
    source.identity.kind === "gateway"
      ? await prepareGatewayModelEnvironment(
          db,
          source,
          {
            selectedModel,
            framework,
            modelProviderType: credential.pin.modelProvider,
          },
          signal,
        )
      : source.identity.kind === "built-in"
        ? await prepareManagedModelEnvironment(
            db,
            source,
            {
              builtInModelRuntimeRoute: credential.route ?? undefined,
              selectedModelOverride: selectedModel,
              catalog,
              framework,
              featureSwitchContext: admitted.featureSwitchContext,
            },
            signal,
          )
        : await prepareRegisteredModelEnvironment(
            db,
            source,
            selectedModel,
            {
              catalog,
              userId: job.userId,
              sourceId: credential.pin.modelProviderId ?? "",
              piExecution: true,
            },
            signal,
          );
  signal.throwIfAborted();
  const piArgs = {
    catalog,
    userId: job.userId,
    orgId: job.orgId,
    piExecution: true,
    codexServiceTier: undefined,
    agentRunMetadata: undefined,
  } as const;
  const modelProvider = resolvedProvider
    ? await materializePreparedPiProvider(piArgs, resolvedProvider)
    : null;
  if (!modelProvider) {
    throw new PiMaintenanceDispositionError("credential_unavailable");
  }
  const piSandbox = resolvePreparedPiModelConfig({
    createArgs: piArgs,
    modelProvider,
  });
  if (!piSandbox) {
    throw new Error("Pi maintenance requires a Pi model configuration");
  }
  return { modelProvider, piSandbox };
}

/** The single exact memory writeback mount at the claimed base version. */
async function prepareMaintenanceStorage(
  job: ClaimedPiMemoryPhase2Job,
  preparedMounts: readonly Parameters<typeof storedMountFromPrepared>[0][],
  timing: ApiDispatchTimingCollector,
) {
  const artifact = {
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: PI_MEMORY_ROOT,
    version: job.baseVersion.versionId,
    missingRootPolicy: "fail" as const,
  };
  const entry = writebackStorageEntryMetadata({
    artifact,
    resolved: {
      storageId: job.baseVersion.storageId,
      versionId: job.baseVersion.versionId,
      s3Prefix: job.s3Prefix,
      s3Key: job.baseVersion.s3Key,
      archiveSize: job.baseVersion.archiveSize,
      fileCount: job.baseVersion.fileCount,
      resolvedOrgId: job.orgId,
      resolvedUserId: job.userId,
    },
    source: "artifact",
  });
  const [prepared] = preparedMounts;
  if (!prepared || preparedMounts.length !== 1) {
    throw new Error("Pi maintenance expects exactly one prepared mount");
  }
  const storage = await finalizePreparedStorage({
    entries: {
      composeEntries: [],
      additionalEntries: [],
      writebackEntries: [
        { ...entry, storedMount: storedMountFromPrepared(prepared, true) },
      ],
      resolvedComposeEntryCount: 0,
      resolvedAdditionalEntryCount: 0,
    },
    timing,
  });
  return { artifact, storage };
}

interface MaintenanceCommit {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly credential: PiMaintenanceCredential;
  readonly selectionDigest: string;
  readonly commit: Omit<CommitPreparedLaunchArgs, "db">;
  readonly apiStartTime: number;
  readonly allowanceRefresh: PreparedUsageAllowanceRefresh | undefined;
}

/** Atomic run + Runner job + job binding; the active-run row is last. */
async function commitMaintenanceRun(db: Db, args: MaintenanceCommit) {
  const { job, commit } = args;
  const enforceBuiltInCredits = commit.enforceBuiltInCredits;
  const prepared: PreparedCommitPreparedLaunchArgs = {
    ...commit,
    db,
    persistence: prepareAtomicLaunchPersistence(commit),
    admissionTiming: new AdmissionAttemptTiming({
      runId: commit.identity.runId,
      runnerGroup: commit.launch.runnerJobPayload.runnerGroup,
      profile: commit.launch.runnerJobPayload.profile,
      dimensions: {},
      triggerSource: "agent",
    }),
  };
  const pending = await db.transaction(async (tx) => {
    prepared.admissionTiming.transactionStarted();
    prepared.admissionTiming.admissionStarted();
    // Pi memory's ownership/version/credential fence, before any write.
    await args.credential.validate(tx);
    // A member subscription account is re-validated and its identity is
    // persisted on the run, as on every other run-creation path.
    const subscription = await validateCapturedSubscriptionAccount(
      tx,
      prepared,
    );
    if (subscription && !("identity" in subscription)) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    const capabilities = enforceBuiltInCredits
      ? await loadOrgPlanCapabilities(tx, job.orgId, { forUpdate: true })
      : null;
    const creditAdmitted =
      enforceBuiltInCredits &&
      isFreePlanForCreditAdmission(capabilities?.planKey);
    const rows = {
      tx,
      commit: prepared,
      payload: prepared.persistence.payload,
      validatedThreadSession: undefined,
      validatedAccountIdentity: subscription?.identity ?? null,
    };
    const persisted = await persistPendingAtomicLaunch(
      rows,
      buildAtomicLaunchCteContext(rows, creditAdmitted),
    );
    await bindPiMemoryPhase2MaintenanceRun(tx, {
      runId: persisted.run.id,
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
      await activateUsageAllowanceWindowsForRun(tx, {
        orgId: job.orgId,
        runId: persisted.run.id,
        runCreatedAt: persisted.run.createdAt,
        refresh: args.allowanceRefresh,
      });
    }
    // The unique active-run insert stays the final statement.
    await tx.insert(activeAgentRuns).values({
      runId: persisted.run.id,
      orgId: job.orgId,
      userId: job.userId,
      chatThreadId: null,
      lastHeartbeatAt: persisted.run.createdAt,
    });
    prepared.admissionTiming.callbackFinished();
    return {
      ...persisted,
      runnerJobPayload: prepared.persistence.payload,
      runContextSnapshot: prepared.launch.runContextSnapshot,
      queueFirstClaim: undefined,
    };
  });
  // Commit is creation success; nothing after this point rejects the claim.
  const transactionReturnedAt = now();
  await prepared.admissionTiming.finish(admissionAttemptOutcome(pending));
  const response = committedAtomicLaunchResponse({
    createArgs: commit.createArgs,
    committed: pending,
    transactionReturnedAt,
    timing: commit.timing,
    phaseTiming: new ApiDispatchPhaseCollector(args.apiStartTime),
  });
  return {
    runId: pending.run.id,
    pendingActivation: response.pendingActivation,
  };
}

/** Model firewall/permission manifest and usage pricing for the run. */
async function prepareMaintenanceUsage(args: {
  readonly db: ReadonlyDb;
  readonly resolution: Parameters<typeof loadRunRoutePricing>[1]["resolution"];
  readonly catalog: MaintenanceAdmission["catalog"];
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly timing: ApiDispatchTimingCollector;
}) {
  const { catalog, modelProvider } = args;
  const permissionManifest = await buildPreparedPermissionManifest({
    connectorCatalogSelection: { kind: "empty" },
    body: { permissionPolicies: undefined, vars: undefined, secrets: {} },
    modelProvider,
    storedConnectorMetadataContext: emptyBuiltinConnectorContext(),
    customConnectorContext: emptyCustomConnectorRuntimeContext(),
    timing: args.timing,
  });
  if (isRouteError(permissionManifest)) {
    throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
  }
  const usage = prepareModelUsageContext({
    catalog,
    modelProvider,
    permissionManifest,
    routePricing: await loadRunRoutePricing(args.db, {
      catalog,
      modelProvider,
      serviceTier: undefined,
      resolution: args.resolution,
    }),
  });
  if (isRouteError(usage)) {
    throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
  }
  return { permissionManifest, usage };
}

function maintenanceCommitArgs(args: {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly pin: PiMaintenanceCredential["pin"];
  readonly runId: string;
  readonly apiStartTime: number;
  readonly body: CreateRunBody;
  readonly selectedImageModel: CommitPreparedLaunchArgs["context"]["selectedImageModel"];
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly selectionDigest: string;
  readonly launch: CommitPreparedLaunchArgs["launch"] | undefined;
  readonly timing: ApiDispatchTimingCollector;
}) {
  const { job, runId, body } = args;
  return {
    createArgs: {
      userId: job.userId,
      orgId: job.orgId,
      body,
      apiStartTime: args.apiStartTime,
      chatThreadId: undefined,
      agentRunMetadata: undefined,
      agentRunModelPin: args.pin,
      codexServiceTier: undefined,
      queueFirstAssociation: undefined,
      timingDimensions: {},
      persistProducerRunBinding: undefined,
    },
    enforceBuiltInCredits: isBuiltInModelProviderType(args.modelProvider.type),
    context: {
      body,
      selectedImageModel: args.selectedImageModel,
      launchSnapshot: args.launchSnapshot,
      officialWorkflowRun: undefined,
      resolved: { agentId: null, continuedFromAgentSessionId: undefined },
      modelProvider: args.modelProvider,
    },
    identity: { runId, sessionId: randomUUID(), shouldCreateSession: true },
    callbackRows: [
      {
        runId,
        url: null,
        internalKind: "pi-memory:phase2",
        encryptedSecret: null,
        payload: maintenanceCallbackPayload(job, args.selectionDigest),
      },
    ],
    launch: args.launch,
    timing: args.timing,
  };
}

function withLaunch(
  commit: ReturnType<typeof maintenanceCommitArgs>,
  launch: CommitPreparedLaunchArgs["launch"],
): Omit<CommitPreparedLaunchArgs, "db"> {
  return { ...commit, launch };
}

interface MaintenanceLaunchArgs {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly runId: string;
  readonly body: CreateRunBody;
  readonly framework: MaintenanceAdmission["framework"];
  readonly piSandbox: Awaited<
    ReturnType<typeof prepareMaintenanceModel>
  >["piSandbox"];
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly permissionManifest: Awaited<
    ReturnType<typeof prepareMaintenanceUsage>
  >["permissionManifest"];
  readonly usage: Awaited<ReturnType<typeof prepareMaintenanceUsage>>["usage"];
  readonly apiStartTime: number;
  readonly disabledPaidTools: readonly string[];
  readonly userTimezone: string | undefined;
  readonly featureSwitchContext: MaintenanceAdmission["featureSwitchContext"];
  readonly encryptedSecrets: Parameters<
    typeof buildStoredExecutionContextDraft
  >[1];
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly storage: Awaited<
    ReturnType<typeof prepareMaintenanceStorage>
  >["storage"];
  readonly artifact: Awaited<
    ReturnType<typeof prepareMaintenanceStorage>
  >["artifact"];
  readonly selectionDigest: string;
}

/** Pi-private runner payload: stored context, Pi maintenance launch, job. */
function buildMaintenanceRunnerLaunch(args: MaintenanceLaunchArgs) {
  const {
    job,
    runId,
    body,
    framework,
    piSandbox,
    modelProvider,
    permissionManifest,
    usage,
    disabledPaidTools,
  } = args;
  const contextDraft = buildStoredExecutionContextDraft(
    {
      runId,
      userId: job.userId,
      orgId: job.orgId,
      chatThreadId: undefined,
      resolved: {
        orgId: job.orgId,
        agentId: null,
        ownerUserId: job.userId,
        content: MAINTENANCE_CONTENT,
        artifacts: [],
      },
      body,
      framework,
      piSandbox,
      modelProvider,
      connectorContext: emptyBuiltinConnectorContext(),
      customConnectorContext: emptyCustomConnectorRuntimeContext(),
      permissionManifest,
      billableFirewalls: usage.billableFirewalls,
      modelUsageProvider: usage.modelUsageProvider,
      modelUsageLongContextMinTotalInputTokens:
        usage.modelUsageLongContextMinTotalInputTokens,
      apiStartTime: args.apiStartTime,
      additionalVolumes: undefined,
      platformEnvironment: withPaidToolPlatformEnvironment(
        { framework, modelProvider, piSandbox, disabledPaidTools },
        undefined,
      ),
      userTimezone: args.userTimezone,
      featureSwitchContext: args.featureSwitchContext,
      includeOkouTokenSecret: false,
    },
    args.encryptedSecrets,
  );
  return assembleRunnerLaunch({
    runId,
    userId: job.userId,
    chatThreadId: undefined,
    launchSnapshot: args.launchSnapshot,
    runnerGroup: preparedRunnerGroup(MAINTENANCE_CONTENT),
    body,
    checkpointArtifacts: [args.artifact],
    preparedStorage: args.storage,
    contextDraft,
    piResources: assemblePiLaunchResources({
      modelConfig: piSandbox,
      piLaunchConfig: {
        maintenance: maintenancePayload(job, args.selectionDigest),
      },
      memoryRecall: undefined,
      resumeSession: undefined,
      sessionId: runId,
    }),
  });
}

function maintenanceRunBody(
  framework: MaintenanceAdmission["framework"],
  storedImageModel: string | null | undefined,
) {
  const selectedImageModel = isImageModelId(storedImageModel)
    ? storedImageModel
    : DEFAULT_IMAGE_MODEL;
  const launchSnapshot: AgentRunFullLaunchSnapshot = {
    schemaVersion: 3,
    framework: "pi",
    runnerProfile: runnerProfile(MAINTENANCE_CONTENT),
  };
  const body: CreateRunBody = withFinalRunAppendSystemPrompt({
    // An encrypted namespace must exist for dynamic model secrets.
    body: { prompt: MAINTENANCE_PROMPT, triggerSource: "agent", secrets: {} },
    framework,
    chatThreadId: undefined,
    imageRecognitionAvailable: false,
    mcpConnectorSlugs: [],
    selectedImageModel,
    cliAvailable: false,
  });
  return { body, launchSnapshot, selectedImageModel };
}

type PendingActivation = ReturnType<
  typeof committedAtomicLaunchResponse
>["pendingActivation"];

/** Post-commit activation; the run already exists and is not compensated. */
const activateMaintenanceRun$ = command(
  async (
    { set },
    activation: PendingActivation,
    signal: AbortSignal,
  ): Promise<void> => {
    if (activation) {
      await set(
        activatePendingRun$,
        {
          notification: activation.runnerNotification,
          timing: activation.timing,
          activationScheduledAt: now(),
        },
        signal,
      );
    }
  },
);

interface MaintenanceRunFacts {
  readonly job: ClaimedPiMemoryPhase2Job;
  readonly runId: string;
  readonly apiStartTime: number;
  readonly body: CreateRunBody;
  readonly selectedImageModel: CommitPreparedLaunchArgs["context"]["selectedImageModel"];
  readonly launchSnapshot: AgentRunFullLaunchSnapshot;
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly selectionDigest: string;
  readonly timing: ApiDispatchTimingCollector;
}

/** Storage, encrypted secrets and the Pi runner payload for one run. */
type PreparedMaintenanceMounts = Parameters<
  typeof prepareMaintenanceStorage
>[1];

type MaintenancePreparationArgs = MaintenanceRunFacts &
  Omit<MaintenanceLaunchArgs, "encryptedSecrets" | "storage" | "artifact"> & {
    // Read in parallel with admission facts; a failed read fails this launch
    // preparation (and records the failed run) like any other storage step.
    readonly preparedMounts: Awaited<
      ReturnType<typeof settle<PreparedMaintenanceMounts>>
    >;
  };

const prepareMaintenanceLaunch$ = command(
  async ({ set }, args: MaintenancePreparationArgs, signal: AbortSignal) => {
    if (!args.preparedMounts.ok) {
      throw args.preparedMounts.error;
    }
    const { artifact, storage } = await prepareMaintenanceStorage(
      args.job,
      args.preparedMounts.value,
      args.timing,
    );
    signal.throwIfAborted();
    const encryptedSecrets = await set(
      encryptExecutionSecrets$,
      buildStoredExecutionSecrets({
        connectorContext: emptyBuiltinConnectorContext(),
        modelProvider: args.modelProvider,
        bodySecrets: args.body.secrets,
        customConnectorContext: emptyCustomConnectorRuntimeContext(),
      }).secrets ?? null,
      signal,
    );
    signal.throwIfAborted();
    return buildMaintenanceRunnerLaunch({
      ...args,
      encryptedSecrets,
      storage,
      artifact,
    });
  },
);

/** The failed run record, callback rows and claim fence re-validation. */
async function recordFailedMaintenanceLaunch(
  db: Db,
  args: MaintenanceRunFacts & {
    readonly credential: PiMaintenanceCredential;
    readonly error: unknown;
  },
): Promise<void> {
  const commit = maintenanceCommitArgs({
    ...args,
    pin: args.credential.pin,
    launch: undefined,
  });
  const rows: LaunchRunRowsArgs = {
    userId: args.job.userId,
    orgId: args.job.orgId,
    identity: commit.identity,
    status: "failed",
    resolved: commit.context.resolved,
    body: args.body,
    runStorageMounts: undefined,
    sessionStorageMounts: undefined,
    modelProvider: args.modelProvider,
    agentRunModelPin: args.credential.pin,
    selectedImageModel: args.selectedImageModel,
    callbackRows: commit.callbackRows,
    chatThreadId: undefined,
    agentRunMetadata: undefined,
    apiStartTime: args.apiStartTime,
    runnerGroup: undefined,
    launchSnapshot: args.launchSnapshot,
    langfuseTraceEnabled: false,
    officialWorkflowProvenance: undefined,
    error: args.error instanceof Error ? args.error.message : "Run failed",
    creditAdmitted: false,
  };
  await db.transaction(async (tx) => {
    const createdAt = nowDate();
    const metadata = launchRunMetadataValues(rows);
    await tx.insert(agentSessions).values(launchSessionValues(rows));
    await tx
      .insert(agentRuns)
      .values(launchRunValues(rows, createdAt, metadata));
    const capture = billingRunAttributionWrite({
      id: commit.identity.runId,
      orgId: rows.orgId,
      userId: rows.userId,
      startedAt: createdAt.toISOString(),
      triggerSource: metadata.triggerSource,
      threadId: metadata.chatThreadId,
    });
    const [attribution] = await tx
      .insert(billingRunAttribution)
      .values(capture.values)
      .onConflictDoUpdate(capture.conflict)
      .returning({ id: billingRunAttribution.runId });
    if (!attribution) {
      throw new Error("New Run billing attribution conflicts with history");
    }
    await tx.insert(agentRunCallbacks).values([...commit.callbackRows]);
    await args.credential.validate(tx);
  });
}

/**
 * Launch preparation and, for a built-in model, the Stripe entitlement refresh
 * for the allowance window run together outside the transaction. Either
 * failure fails the whole preparation, which records the failed run, as the
 * shared launch preparation does.
 */
const prepareMaintenanceLaunchAndAllowance$ = command(
  async ({ set }, args: MaintenancePreparationArgs, signal: AbortSignal) => {
    return await settle(
      Promise.all([
        set(prepareMaintenanceLaunch$, args, signal),
        isBuiltInModelProviderType(args.modelProvider.type)
          ? set(
              prepareUsageAllowanceRefresh$,
              { orgId: args.job.orgId },
              signal,
            )
          : undefined,
      ]),
      signal,
    );
  },
);

/**
 * Independent memory-maintenance sandbox execution for one claimed Pi
 * Phase 2 job. It prepares the exact memory mount, the selected model
 * credential and the Pi maintenance launch, atomically commits the run with
 * its job binding, then activates it. It never enters Thread admission or
 * Agent resolution. A committed execution is creation success; later
 * activation/cache failures are not compensated.
 */
export const startMaintenanceRun$ = command(
  async (
    { get, set },
    job: ClaimedPiMemoryPhase2Job,
    signal: AbortSignal,
  ): Promise<string> => {
    const db = set(writeDb$);
    const apiStartTime = now();
    const admitted = await admitMaintenance(db, job, signal);
    const timing = new ApiDispatchTimingCollector();
    const owner = { orgId: job.orgId, userId: job.userId };
    const storageObjects = createExecutionStorageObjects([
      {
        mode: "writeback",
        ...owner,
        storageId: job.baseVersion.storageId,
        versionId: job.baseVersion.versionId,
        name: AUTO_MEMORY_ARTIFACT_NAME,
        mountPath: PI_MEMORY_ROOT,
        missingRootPolicy: "fail",
      },
    ]);
    const [source, member, disabledPaidTools, preparedMounts] =
      await Promise.all([
        get(
          createModelSourceSnapshot({
            ...owner,
            source: pinnedSourceIdentity(admitted.credential),
          }),
        ),
        get(createExecutionMemberMetadata(owner)),
        get(createAgentDisabledPaidTools(job.userId, job.orgId)),
        settle(get(storageObjects.preparedMounts$), signal),
      ]);
    signal.throwIfAborted();
    if (!source) {
      throw new PiMaintenanceDispositionError("credential_unavailable");
    }
    const { modelProvider, piSandbox } = await prepareMaintenanceModel(
      db,
      admitted,
      job,
      source,
      signal,
    );
    signal.throwIfAborted();
    const { catalog, framework } = admitted;
    const { permissionManifest, usage } = await prepareMaintenanceUsage({
      db: get(db$),
      resolution: get(usagePricingResolution$),
      catalog,
      modelProvider,
      timing,
    });
    signal.throwIfAborted();
    const runId = randomUUID();
    const selectionDigest = piMemoryPhase2SelectionDigest(job.selected);
    const { body, launchSnapshot, selectedImageModel } = maintenanceRunBody(
      framework,
      member.preferences?.selectedImageModel,
    );
    const runFacts = {
      job,
      runId,
      apiStartTime,
      body,
      selectedImageModel,
      launchSnapshot,
      modelProvider,
      selectionDigest,
      timing,
    };
    const prepared = await set(
      prepareMaintenanceLaunchAndAllowance$,
      {
        ...runFacts,
        framework,
        piSandbox,
        permissionManifest,
        usage,
        disabledPaidTools,
        userTimezone: member.preferences?.timezone ?? undefined,
        featureSwitchContext: admitted.featureSwitchContext,
        preparedMounts,
      },
      signal,
    );
    if (!prepared.ok) {
      // Launch preparation failed after admission: keep the failed run record
      // (with its callback rows) and re-validate the claim fence, binding nothing.
      await recordFailedMaintenanceLaunch(db, {
        ...runFacts,
        credential: admitted.credential,
        error: prepared.error,
      });
      signal.throwIfAborted();
      throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
    }
    const [launch, preparedAllowanceRefresh] = prepared.value;
    const commit = withLaunch(
      maintenanceCommitArgs({
        ...runFacts,
        pin: admitted.credential.pin,
        launch,
      }),
      launch,
    );
    const committed = await commitMaintenanceRun(db, {
      job,
      allowanceRefresh: preparedAllowanceRefresh,
      credential: admitted.credential,
      selectionDigest,
      commit,
      apiStartTime,
    });
    signal.throwIfAborted();
    await set(activateMaintenanceRun$, committed.pendingActivation, signal);
    // The approved log-only presigned URL cache write.
    const cache = await settle(
      set(storageObjects.updatePresignedUrlCache$, signal),
      signal,
    );
    if (!cache.ok) {
      log.warn("Pi maintenance presigned URL cache update failed", {
        runId: committed.runId,
      });
    }
    return committed.runId;
  },
);
