import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { PI_MEMORY_ROOT } from "@okouai/api-contracts/contracts/runners";
import {
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
} from "@okouai/api-contracts/contracts/model-providers";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { DEFAULT_IMAGE_MODEL } from "@okouai/core/image-model-catalog";
import { piMemoryPhase2SelectionDigest } from "@okouai/pi-agent-runtime/api";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { now } from "../../lib/time";
import { logger } from "../../lib/log";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { usagePricingResolution$ } from "../context/usage-pricing-resolution";
import { settle } from "../utils";
import {
  ApiDispatchTimingCollector,
  ApiDispatchPhaseCollector,
} from "./api-dispatch-timing.service";
import { AdmissionAttemptTiming } from "./api-dispatch-admission-timing.service";
import { activatePendingRun$ } from "./agent-run-activation.service";
import type { PendingRunActivation } from "./agent-run-activation.types";
import { createExecutionMemberMetadata } from "./execution-member-metadata.service";
import { createAgentDisabledPaidTools } from "./agent-bootstrap-resources";
import {
  createModelSourceSnapshot,
  type ModelSourceIdentity,
  prepareGatewayModelEnvironment,
  prepareManagedModelEnvironment,
  prepareRegisteredModelEnvironment,
  frameworkForProviderSelection,
  loadRunRoutePricing,
  materializePreparedPiProvider,
  prepareModelUsageContext,
  resolvePreparedPiModelConfig,
  type ResolvedModelProviderEnvironment,
} from "./execution-model-source.service";
import {
  createExecutionStorageObjects,
  AUTO_MEMORY_ARTIFACT_NAME,
  finalizePreparedStorage,
  storedMountFromPrepared,
  writebackStorageEntryMetadata,
} from "./execution-storage.service";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  modelProviderExecutionPermissionManifest,
  sessionStorageMountsForPersistence,
  assemblePiLaunchResources,
  RESTRICTED_EXPLICIT_CONTENT_PROMPT,
  builtInImageModelPrompt,
} from "./thread-claim-run.service";
import {
  MAINTENANCE_RUNNER_PROFILE,
  buildMaintenanceExecutionContext,
  ingestMaintenanceRunContext,
  insertFailedMaintenanceRun,
  insertPendingMaintenanceRun,
  maintenanceExecutionSecrets,
  maintenanceRunnerGroup,
  maintenanceRunnerNotification,
  validateMaintenanceSubscription,
  type MaintenanceLaunch,
  type MaintenanceRunRecord,
} from "./pi-memory-maintenance-launch";
import { loadModelCatalog } from "./model-catalog.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import {
  activateUsageAllowanceWindowsForRun,
  type PreparedUsageAllowanceRefresh,
  prepareUsageAllowanceRefresh$,
} from "./usage-allowance.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  checkOrgCreditsForRunAdmission,
  isFreePlanForCreditAdmission,
} from "./run-admission.service";
import {
  checkPiMemoryQuota,
  PiMemoryQuotaError,
} from "./pi-memory-quota.service";
import {
  PiMemoryPhase2CredentialError,
  resolvePiMemoryPhase2Credential,
} from "./pi-memory-phase2-credential.service";
import { bindPiMemoryPhase2MaintenanceRun } from "./pi-memory-phase2-maintenance.service";
import type { ClaimedPiMemoryPhase2Job } from "./pi-memory-phase2-job.service";

const log = logger("PiMemoryMaintenanceExecution");

const MAINTENANCE_PROMPT = "Run first-party Pi memory maintenance.";

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

/** Model firewall/permission manifest and usage pricing for the run. */
async function prepareMaintenanceUsage(args: {
  readonly db: ReadonlyDb;
  readonly resolution: Parameters<typeof loadRunRoutePricing>[1]["resolution"];
  readonly catalog: MaintenanceAdmission["catalog"];
  readonly modelProvider: ResolvedModelProviderEnvironment;
  readonly timing: ApiDispatchTimingCollector;
}) {
  const { catalog, modelProvider } = args;
  const permissionManifest = await modelProviderExecutionPermissionManifest(
    modelProvider,
    args.timing,
  );
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
  if ("status" in usage) {
    throw new PiMaintenanceDispositionError("maintenance_dispatch_failed");
  }
  return { permissionManifest, usage };
}

/** The selected model's runtime, then its usage pricing and permissions. */
async function prepareMaintenanceModelAndUsage(
  args: {
    readonly db: Db;
    readonly readDb: ReadonlyDb;
    readonly resolution: Parameters<
      typeof prepareMaintenanceUsage
    >[0]["resolution"];
    readonly admitted: MaintenanceAdmission;
    readonly job: ClaimedPiMemoryPhase2Job;
    readonly source: NonNullable<Parameters<typeof prepareMaintenanceModel>[3]>;
    readonly timing: ApiDispatchTimingCollector;
  },
  signal: AbortSignal,
) {
  const { modelProvider, piSandbox } = await prepareMaintenanceModel(
    args.db,
    args.admitted,
    args.job,
    args.source,
    signal,
  );
  signal.throwIfAborted();
  const { permissionManifest, usage } = await prepareMaintenanceUsage({
    db: args.readDb,
    resolution: args.resolution,
    catalog: args.admitted.catalog,
    modelProvider,
    timing: args.timing,
  });
  signal.throwIfAborted();
  return { modelProvider, piSandbox, permissionManifest, usage };
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
      piResources: assemblePiLaunchResources({
        modelConfig: args.piSandbox,
        piLaunchConfig: {
          maintenance: maintenancePayload(args.job, args.selectionDigest),
        },
        memoryRecall: undefined,
        resumeSession: undefined,
        sessionId: record.runId,
      }),
    });
    const runStorageMounts = [...storage.persistedStorageMounts];
    return {
      ...built,
      runnerGroup,
      runStorageMounts,
      sessionStorageMounts: sessionStorageMountsForPersistence({
        resolvedMounts: runStorageMounts,
        artifacts: [artifact],
      }),
      runContextStorage: storage.runContextStorage,
    };
  },
);

/**
 * Launch preparation and, for a built-in model, the Stripe entitlement refresh
 * for the allowance window run together outside the transaction. Either
 * failure fails the whole preparation, which records the failed run.
 */
const prepareMaintenanceLaunchAndAllowance$ = command(
  async ({ set }, args: MaintenanceLaunchInput, signal: AbortSignal) => {
    return await settle(
      Promise.all([
        set(prepareMaintenanceLaunch$, args, signal),
        isBuiltInModelProviderType(args.record.modelProvider.type)
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
async function commitMaintenanceRun(
  db: Db,
  args: {
    readonly job: ClaimedPiMemoryPhase2Job;
    readonly credential: PiMaintenanceCredential;
    readonly selectionDigest: string;
    readonly record: MaintenanceRunRecord;
    readonly launch: MaintenanceLaunch;
    readonly allowanceRefresh: PreparedUsageAllowanceRefresh | undefined;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<PendingRunActivation> {
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
    const capabilities = enforceBuiltInCredits
      ? await loadOrgPlanCapabilities(tx, job.orgId, { forUpdate: true })
      : null;
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
      await activateUsageAllowanceWindowsForRun(tx, {
        orgId: job.orgId,
        runId: record.runId,
        runCreatedAt: rows.createdAt,
        refresh: args.allowanceRefresh,
      });
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
  const transactionReturnedAt = now();
  await admissionTiming.finish("pending");
  const phaseTiming = new ApiDispatchPhaseCollector(record.apiStartTime);
  phaseTiming.checkpoint(
    "api_dispatch_phase_queue_insert",
    persisted.runnerJobCreatedAt.getTime(),
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
      persisted.runnerJobCreatedAt,
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
    name: AUTO_MEMORY_ARTIFACT_NAME,
    mountPath: PI_MEMORY_ROOT,
    missingRootPolicy: "fail" as const,
  };
}

/**
 * One claimed job's maintenance graph. Construction captures the plain job
 * and builds the storage (with its cache command), member and paid-tool nodes
 * once; launch$ admits the job (which may refresh a subscription), prepares
 * the exact memory mount, the pinned model and the Pi launch, atomically
 * commits the run with its job binding, then activates it. The pinned source
 * is known only after admission; its snapshot is a pure computed read.
 */
function createMaintenanceRunObjects(job: ClaimedPiMemoryPhase2Job) {
  const owner = { orgId: job.orgId, userId: job.userId };
  const storageObjects = createExecutionStorageObjects([
    maintenanceMemoryMount(job),
  ]);
  const member$ = createExecutionMemberMetadata(owner);
  const disabledPaidTools$ = createAgentDisabledPaidTools(
    job.userId,
    job.orgId,
  );
  const launch$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<string> => {
      const db = set(writeDb$);
      const apiStartTime = now();
      const admitted = await admitMaintenance(db, job, signal);
      const timing = new ApiDispatchTimingCollector();
      const [source, member, disabledPaidTools, preparedMounts] =
        await Promise.all([
          get(
            createModelSourceSnapshot({
              ...owner,
              source: pinnedSourceIdentity(admitted.credential),
            }),
          ),
          get(member$),
          get(disabledPaidTools$),
          settle(get(storageObjects.preparedMounts$), signal),
        ]);
      signal.throwIfAborted();
      if (!source) {
        throw new PiMaintenanceDispositionError("credential_unavailable");
      }
      const { modelProvider, piSandbox, permissionManifest, usage } =
        await prepareMaintenanceModelAndUsage(
          {
            db,
            readDb: get(db$),
            resolution: get(usagePricingResolution$),
            admitted,
            job,
            source,
            timing,
          },
          signal,
        );
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
      const prepared = await set(
        prepareMaintenanceLaunchAndAllowance$,
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
      );
      if (!prepared.ok) {
        return await failMaintenanceLaunch(
          db,
          { record, credential: admitted.credential, error: prepared.error },
          signal,
        );
      }
      const [launch, allowanceRefresh] = prepared.value;
      const activation = await commitMaintenanceRun(db, {
        job,
        credential: admitted.credential,
        selectionDigest,
        record,
        launch,
        allowanceRefresh,
        timing,
      });
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
      // The approved log-only presigned URL cache write.
      const cache = await settle(
        set(storageObjects.updatePresignedUrlCache$, signal),
        signal,
      );
      if (!cache.ok) {
        log.warn("Pi maintenance presigned URL cache update failed", {
          runId: record.runId,
        });
      }
      return record.runId;
    },
  );
  return { launch$ };
}

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
      set(createMaintenanceRunObjects(job).launch$, signal),
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
