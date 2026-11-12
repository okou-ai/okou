import { performance } from "node:perf_hooks";
import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  CANONICAL_PI_MEMORY_MOUNT_PATH,
  PI_SKILLS_ROOT,
  type PiModelConfig,
  type StorageMountEntry,
  type PreparedExecutionContext,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import { now } from "../../lib/time";
import type { PreparedExecutionStorageMount } from "./execution-storage.service";
import type {
  OfficialWorkflowObservation,
  OfficialWorkflowRunObservation,
} from "./official-workflow-run.service";
import {
  type ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { MEMORY_ARTIFACT_NAME } from "@okouai/core/storage-names";
import {
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
  VERSION_ID_LENGTH,
} from "@okouai/core/version-id";
import type { PersistedStorageMount } from "@okouai/db/types";
import { cacheRowsFromProjection } from "./execution-storage-cache-read.service";
import type {
  StorageIndex,
  StorageIndexEntry,
  StorageLookup,
  StorageRequest,
  StorageVersionIndexEntry,
} from "./storage-index.service";
import { normalizeMountOverlay } from "./storage-mount-overlay";

interface PrepareAgentRunStorageManifestArgs {
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
}

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
}

interface BuildStorageManifestEntriesArgs {
  readonly storageIndex: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
}

type UnindexedStorageManifestEntriesArgs = Omit<
  BuildStorageManifestEntriesArgs,
  "storageIndex"
>;

interface PreparedRequestStorageResolution {
  readonly input: UnindexedStorageManifestEntriesArgs;
  readonly requests: readonly StorageRequest[];
}

interface StorageManifestEntryPhaseTimings {
  readonly artifact: StorageManifestEntryPhaseTiming;
}

interface ResolvedStorageEntries {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
  readonly resolved: ResolvedStorageManifestEntryPlans;
}

/** One immutable storage selection per Run preparation attempt. */
export interface ResolvedAgentRunStorage {
  readonly metadata: PreparedAgentRunStorage<StorageMountMetadata>;
  readonly requested: ResolvedStorageEntries;
}

/** Read-only selection. Missing writeback roots are initialized by materialization. */
export interface AgentRunStoragePlan {
  readonly requested: ResolvedStorageEntries;
  readonly missingArtifacts: readonly ContextArtifact[];
}

interface ResolvedStorageManifestEntryPlans {
  readonly artifactInputs: readonly ResolvedManifestArtifactInput[];
}

interface StorageManifestPhaseTimingWindow {
  startedAt: number | undefined;
  finishedAt: number | undefined;
}

class StorageManifestEntryPhaseTiming {
  private readonly resolveWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };

  constructor(
    private readonly timing: ApiDispatchTimingCollector | undefined,
    private readonly resolveActionType: ApiDispatchTimingActionType,
  ) {}

  async measureResolve<T>(operation: () => T | Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  flushResolve(): void {
    this.record(this.resolveActionType, this.resolveWindow);
  }

  private async measure<T>(
    window: StorageManifestPhaseTimingWindow,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    if (!this.timing) {
      return await operation();
    }

    const startedAt = now();
    window.startedAt =
      window.startedAt === undefined
        ? startedAt
        : Math.min(window.startedAt, startedAt);
    const invoke = async () => {
      return await operation();
    };
    return await invoke().finally(() => {
      const finishedAt = now();
      window.finishedAt =
        window.finishedAt === undefined
          ? finishedAt
          : Math.max(window.finishedAt, finishedAt);
    });
  }

  private record(
    actionType: ApiDispatchTimingActionType,
    window: StorageManifestPhaseTimingWindow,
  ): void {
    if (!this.timing) {
      return;
    }

    const finishedAt = window.finishedAt ?? now();
    this.timing.recordElapsed(
      actionType,
      "nested",
      window.startedAt ?? finishedAt,
      finishedAt,
    );
  }
}

function dedupArtifacts(
  artifacts: readonly ContextArtifact[],
): readonly ContextArtifact[] {
  const byName = new Map<string, ContextArtifact>();
  for (const artifact of artifacts) {
    byName.set(artifact.name, artifact);
  }
  return [...byName.values()];
}

export function storageIndexKey(
  orgId: string,
  userId: string,
  name: string,
): string {
  return JSON.stringify([orgId, userId, name]);
}

function artifactStorageLookup(
  orgId: string,
  userId: string,
  name: string,
): StorageLookup {
  return { orgId, userId, name };
}

function isFullStorageVersionId(version: string): boolean {
  return version.length === VERSION_ID_LENGTH && isValidVersionPrefix(version);
}

interface StoragePrefixVersionRequest {
  readonly storageId: string;
  readonly version: string;
  readonly lookup: StorageLookup;
}

interface StoragePrefixVersionRow extends StorageVersionIndexEntry {
  readonly storageId: string;
  readonly cacheKey: string | null;
  readonly cacheScope: string | null;
  readonly presignedUrl: string | null;
  readonly expiresAt: Date | null;
}

export function storagePrefixVersionRequests(
  requests: readonly StorageRequest[],
  index: StorageIndex,
): readonly StoragePrefixVersionRequest[] {
  const unique = new Map<string, StoragePrefixVersionRequest>();
  for (const request of requests) {
    const version = request.version;
    if (version === undefined || version === "latest") {
      continue;
    }
    const storage = index.get(
      storageIndexKey(
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
      ),
    );
    if (
      storage &&
      storage.headVersion?.id !== version &&
      !storage.exactVersions.has(version)
    ) {
      unique.set(JSON.stringify([storage.storageId, version]), {
        storageId: storage.storageId,
        version,
        lookup: request.lookup,
      });
    }
  }
  return [...unique.values()];
}

export function storageIndexWithPrefixVersions(
  index: StorageIndex,
  versions: readonly StoragePrefixVersionRow[],
): StorageIndex {
  if (versions.length === 0) {
    return index;
  }
  const byStorage = new Map<string, Map<string, StorageVersionIndexEntry>>();
  for (const version of versions) {
    const entries =
      byStorage.get(version.storageId) ??
      new Map<string, StorageVersionIndexEntry>();
    entries.set(version.id, version);
    byStorage.set(version.storageId, entries);
  }
  return new Map(
    [...index].map(([key, entry]) => {
      const added = byStorage.get(entry.storageId);
      return [
        key,
        added
          ? {
              ...entry,
              exactVersions: new Map([...entry.exactVersions, ...added]),
              cachedUrls: [
                ...(entry.cachedUrls ?? []),
                ...versions
                  .filter((version) => {
                    return version.storageId === entry.storageId;
                  })
                  .flatMap(cacheRowsFromProjection),
              ],
            }
          : entry,
      ];
    }),
  );
}

function resolveLatestVersion(
  index: StorageIndex,
  lookup: StorageLookup,
): StorageResolution {
  const entry = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );

  if (!entry) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  if (!entry.headVersionId) {
    throw new Error(`Storage "${lookup.name}" has no HEAD version`);
  }
  if (!entry.headVersion) {
    throw new Error(`Storage "${lookup.name}" HEAD version not found`);
  }

  return storageResolutionFromVersion(entry, lookup, entry.headVersion);
}

function storageResolutionFromVersion(
  storage: StorageIndexEntry,
  lookup: StorageLookup,
  version: StorageVersionIndexEntry,
): StorageResolution {
  return {
    storageId: storage.storageId,
    versionId: version.id,
    s3Prefix: storage.s3Prefix,
    s3Key: version.s3Key,
    archiveSize: version.archiveSize,
    fileCount: version.fileCount,
    resolvedOrgId: lookup.orgId,
    resolvedUserId: lookup.userId,
  };
}

function resolvePreloadedExactVersion(
  storage: StorageIndexEntry,
  lookup: StorageLookup,
  version: string,
): StorageResolution | null {
  const match =
    storage.headVersion?.id === version
      ? storage.headVersion
      : storage.exactVersions.get(version);
  return match ? storageResolutionFromVersion(storage, lookup, match) : null;
}

function resolvePinnedVersion(
  index: StorageIndex,
  lookup: StorageLookup,
  version: string,
): StorageResolution {
  const storage = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }
  const exactMatch = resolvePreloadedExactVersion(storage, lookup, version);
  if (exactMatch) {
    return exactMatch;
  }
  if (isFullStorageVersionId(version)) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (!isValidVersionPrefix(version)) {
    throw new Error(
      `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
    );
  }
  const versions = new Map(storage.exactVersions);
  if (storage.headVersion) {
    versions.set(storage.headVersion.id, storage.headVersion);
  }
  const matches = [...versions.values()].filter((candidate) => {
    return candidate.id.startsWith(version);
  });
  if (matches.length === 0) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous version prefix "${version}" for storage "${lookup.name}". Please use more characters.`,
    );
  }
  const match = matches[0];
  if (!match) {
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }
  return storageResolutionFromVersion(storage, lookup, match);
}

function resolveStorageVersion(
  index: StorageIndex,
  lookup: StorageLookup,
  version: string | undefined,
): StorageResolution {
  return version === undefined || version === "latest"
    ? resolveLatestVersion(index, lookup)
    : resolvePinnedVersion(index, lookup, version);
}

function resolveArtifactStorageInput(args: {
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
}): ResolvedManifestArtifactInput {
  const resolved = resolveStorageVersion(
    args.index,
    artifactStorageLookup(args.runtimeOrgId, args.userId, args.artifact.name),
    args.artifact.version,
  );
  return { artifact: args.artifact, resolved };
}

export async function resolveStorageManifestInputs(args: {
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
      };
    },
  );
}

function storageManifestRequests(args: {
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
}): readonly StorageRequest[] {
  const requests: StorageRequest[] = [];

  for (const artifact of args.artifacts) {
    requests.push({
      lookup: artifactStorageLookup(
        args.runtimeOrgId,
        args.userId,
        artifact.name,
      ),
      version: artifact.version,
    });
  }

  return requests;
}

function createStorageManifestEntryPhaseTimings(args: {
  readonly timing?: ApiDispatchTimingCollector;
}): StorageManifestEntryPhaseTimings {
  return {
    artifact: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_artifact_versions",
    ),
  };
}

async function resolveStorageManifestEntryPlans(args: {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
}): Promise<ResolvedStorageManifestEntryPlans> {
  const input = args.input;
  const artifactInputs = await (async (
    spanTiming: ApiDispatchTimingCollector | undefined,
  ) => {
    const spanStartedAt = spanTiming ? performance.now() : undefined;
    return await (async () => {
      return await Promise.all(
        input.artifacts.map((artifact) => {
          return args.phaseTimings.artifact.measureResolve(() => {
            return resolveArtifactStorageInput({
              index: input.storageIndex,
              runtimeOrgId: input.runtimeOrgId,
              userId: input.userId,
              artifact,
            });
          });
        }),
      );
    })().finally(() => {
      if (spanTiming && spanStartedAt !== undefined) {
        spanTiming.recordDuration(
          "api_dispatch_prepare_storage_manifest_build_artifact_entries",
          "nested",
          performance.now() - spanStartedAt,
          now(),
        );
      }
    });
  })(input.timing);

  return {
    artifactInputs,
  };
}

export async function resolveStorageEntries(
  input: BuildStorageManifestEntriesArgs,
): Promise<ResolvedStorageEntries> {
  const phaseTimings = createStorageManifestEntryPhaseTimings(input);
  const resolved = await resolveStorageManifestEntryPlans({
    input,
    phaseTimings,
  }).finally(() => {
    phaseTimings.artifact.flushResolve();
  });
  return { input, phaseTimings, resolved };
}

/** Assemble writeback metadata from resolved artifact versions. */
export function storageEntriesMetadata(
  plan: ResolvedStorageEntries,
): PreparedStorageEntries<StorageMountMetadata> {
  return {
    writebackEntries: plan.resolved.artifactInputs.map(
      writebackStorageEntryMetadata,
    ),
  };
}

export function prepareRequestStorageResolution(
  args: {
    readonly runtimeOrgId: string;
    readonly userId: string;
    readonly timing?: ApiDispatchTimingCollector;
  },
  artifacts: readonly ContextArtifact[],
): PreparedRequestStorageResolution {
  const input: UnindexedStorageManifestEntriesArgs = {
    runtimeOrgId: args.runtimeOrgId,
    userId: args.userId,
    artifacts,
    timing: args.timing,
  };
  return {
    input,
    requests: storageManifestRequests(input),
  };
}

export interface AgentRunStorageInput {
  readonly args: PrepareAgentRunStorageManifestArgs;
}

export interface AgentRunStorageSelection {
  readonly args: PrepareAgentRunStorageManifestArgs;
  readonly request: PreparedRequestStorageResolution;
  readonly requests: readonly StorageRequest[];
}

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? `${CANONICAL_CODEX_HOME_DIR}/skills`
    : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
}

function skillsRootForRun(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  return piSandbox === undefined
    ? frameworkSkillsMountPath(framework)
    : PI_SKILLS_ROOT;
}

export interface ResolvedAgentExecution {
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly orgId: string;
  readonly nativeContinuation?: PreparedExecutionContext["nativeContinuation"];
}

interface ResolvedUnboundExecution extends Omit<
  ResolvedAgentExecution,
  "agentId"
> {
  readonly agentId: null;
}

export type ResolvedRunExecution =
  ResolvedAgentExecution | ResolvedUnboundExecution;

const AUTO_MEMORY_MISSING_ROOT_POLICY: ArtifactMissingRootPolicy =
  "preserveParentVersion";

interface RunArtifacts {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
}

interface PreparedRunBundles {
  readonly seedSkillBundles: PreparedExecutionContext["seedSkillBundles"];
  readonly templateGuidanceBundles: PreparedExecutionContext["templateGuidanceBundles"];
}

function autoMemoryMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function artifactsForRun(args: {
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
}): RunArtifacts {
  return {
    artifacts: [
      {
        name: AUTO_MEMORY_ARTIFACT_NAME,
        mountPath:
          args.piSandbox === undefined
            ? autoMemoryMountPath(args.framework)
            : CANONICAL_PI_MEMORY_MOUNT_PATH,
        missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
      },
    ],
  };
}

function preparedRunBundles(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly skillsRoot: string;
}): PreparedRunBundles {
  const candidates = resolveRunSkillVolumes(args.skillVolumes, args.skillsRoot);
  // Select the winning mount before separating Skill and template bundles.
  const winners = normalizeMountOverlay(candidates);
  const templateGuidanceBundles = winners.flatMap((volume, index) => {
    return "templateGuidanceBundle" in volume
      ? [
          {
            ...volume.templateGuidanceBundle,
            beforeMountPaths: winners.slice(index + 1).map((later) => {
              return later.mountPath;
            }),
          },
        ]
      : [];
  });
  const seedSkillBundles = winners.flatMap((volume) => {
    return "contentBundle" in volume
      ? [{ ...volume.contentBundle, mountPath: volume.mountPath }]
      : [];
  });
  return {
    seedSkillBundles,
    templateGuidanceBundles,
  };
}

export function prepareRunOutputMetadata(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly officialWorkflow: OfficialWorkflowObservation | undefined;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
}): {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
  readonly seedSkillBundles: PreparedExecutionContext["seedSkillBundles"];
  readonly templateGuidanceBundles: PreparedExecutionContext["templateGuidanceBundles"];
} {
  const skillsRoot = skillsRootForRun(args.framework, args.piSandbox);
  const bundles = preparedRunBundles({
    skillVolumes: args.skillVolumes,
    skillsRoot,
  });
  const artifacts = artifactsForRun({
    framework: args.framework,
    piSandbox: args.piSandbox,
  }).artifacts;
  return {
    seedSkillBundles: bundles.seedSkillBundles,
    templateGuidanceBundles: bundles.templateGuidanceBundles,
    artifacts,
    officialWorkflowRun: args.officialWorkflow && {
      ...args.officialWorkflow,
      definitions: args.officialWorkflow.definitions.map((definition) => {
        return {
          ...definition,
          mountPath: `${skillsRoot}/${definition.workflowName}`,
        };
      }),
    },
  };
}

type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: PersistedStorageMount["missingRootPolicy"];
}

interface StorageResolution {
  readonly storageId: string;
  readonly versionId: string;
  readonly s3Prefix: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
  readonly resolvedOrgId: string;
  readonly resolvedUserId: string;
}

/** Internal resolved identity, before transport URLs exist. Never persisted. */
type StorageMountMetadata = Omit<StoredStorageMountEntry, "archiveUrl">;

interface PreparedWritebackStorageEntry<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storedMount: TMount;
  readonly persistedMount: PersistedStorageMount;
}

interface PreparedStorageEntries<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly writebackEntries: readonly PreparedWritebackStorageEntry<TMount>[];
}

export interface PreparedAgentRunStorage<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storageMounts: readonly TMount[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
}

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
}

function storageManifestCountBucket(
  count: number,
): "0" | "1" | "2_4" | "5_8" | "9_16" | "17_plus" {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function knownArchiveSize(resolved: StorageResolution): number | undefined {
  return Number.isSafeInteger(resolved.archiveSize) && resolved.archiveSize > 0
    ? resolved.archiveSize
    : undefined;
}

function writebackStorageEntryMetadata(
  input: ResolvedManifestArtifactInput,
): PreparedWritebackStorageEntry<StorageMountMetadata> {
  const { artifact, resolved } = input;
  const storedMountBase = {
    orgId: resolved.resolvedOrgId,
    userId: resolved.resolvedUserId,
    name: artifact.name,
    storageId: resolved.storageId,
    versionId: resolved.versionId,
    mountPath: artifact.mountPath,
    ...(artifact.missingRootPolicy === undefined
      ? {}
      : { missingRootPolicy: artifact.missingRootPolicy }),
    writeback: true as const,
  };
  const preparedBase = {
    persistedMount: {
      orgId: resolved.resolvedOrgId,
      userId: resolved.resolvedUserId,
      name: artifact.name,
      storageId: resolved.storageId,
      version: resolved.versionId,
      mountPath: artifact.mountPath,
      writeback: true as const,
      ...(artifact.missingRootPolicy === undefined
        ? {}
        : { missingRootPolicy: artifact.missingRootPolicy }),
    },
  };
  if (resolved.fileCount === 0) {
    return {
      ...preparedBase,
      storedMount: {
        ...storedMountBase,
        empty: true,
      },
    };
  }

  const archiveSize = knownArchiveSize(resolved);
  return {
    ...preparedBase,
    storedMount: {
      ...storedMountBase,
      ...(archiveSize === undefined ? {} : { archiveSize }),
    },
  };
}

export async function finalizePreparedStorage<
  TMount extends StorageMountMetadata,
>(args: {
  readonly entries: PreparedStorageEntries<TMount>;
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<PreparedAgentRunStorage<TMount>> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      return {
        storageMounts: normalizeMountOverlay(
          args.entries.writebackEntries.map((entry) => {
            return entry.storedMount;
          }),
        ),
        persistedStorageMounts: normalizeMountOverlay(
          args.entries.writebackEntries.map((entry) => {
            return entry.persistedMount;
          }),
        ),
      };
    },
    () => {
      return {
        storage_manifest_final_artifact_count_bucket:
          storageManifestCountBucket(args.entries.writebackEntries.length),
      };
    },
  );
}

export const AUTO_MEMORY_ARTIFACT_NAME = MEMORY_ARTIFACT_NAME;

/** Runner storage mount for one prepared exact execution storage mount. */
export function storedMountFromPrepared(
  prepared: PreparedExecutionStorageMount,
  preserveExplicitMissingRootPolicy: boolean,
): StoredStorageMountEntry {
  const identity = {
    orgId: prepared.orgId,
    userId: prepared.userId,
    storageId: prepared.storageId,
    versionId: prepared.versionId,
    name: prepared.name,
    mountPath: prepared.mountPath,
  };
  if (prepared.writeback) {
    const policy = preserveExplicitMissingRootPolicy
      ? { missingRootPolicy: prepared.missingRootPolicy }
      : {};
    return prepared.empty
      ? { ...identity, writeback: true, empty: true, ...policy }
      : {
          ...identity,
          writeback: true,
          archiveUrl: prepared.archiveUrl,
          ...(prepared.archiveSize > 0
            ? { archiveSize: prepared.archiveSize }
            : {}),
          ...policy,
        };
  }
  return {
    ...identity,
    archiveUrl: prepared.archiveUrl,
    ...(prepared.archiveSize > 0 ? { archiveSize: prepared.archiveSize } : {}),
  };
}
