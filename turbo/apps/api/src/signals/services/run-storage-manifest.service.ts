import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CLAUDE_MEMORY_MOUNT_PATH,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_MEMORY_MOUNT_PATH,
  PI_AGENT_DIR,
  PI_MEMORY_ROOT,
  PI_SKILLS_ROOT,
  type PiModelConfig,
  type StorageMountEntry,
  type StoredExecutionContext,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import {
  resolveRunSkillVolumes,
  type SkillVolume,
} from "./run-prompt-and-skills";
import { now } from "../../lib/time";
import type { ReadonlyDb } from "../external/db";
import { safeSync } from "../utils";
import type { PreparedExecutionStorageMount } from "./execution-storage.service";
import type {
  OfficialWorkflowObservation,
  OfficialWorkflowRunObservation,
} from "./official-workflow-run.service";
import {
  type ApiDispatchTimingActionType,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import {
  getInstructionsFilename,
  type SupportedFramework,
} from "@okouai/core/frameworks";
import {
  MEMORY_ARTIFACT_NAME,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
  VERSION_ID_LENGTH,
} from "@okouai/core/version-id";
import { storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import type { PersistedStorageMount } from "@okouai/db/types";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  cacheRowsFromProjection,
  storageVersionCacheKeySql,
} from "./execution-storage-cache-read.service";
import type { SessionExecutionIdentity } from "./session-compatibility";
import {
  readStorageBaseIndex,
  type StorageIndex,
  type StorageIndexEntry,
  type StorageLookup,
  type StorageRequest,
  type StorageVersionIndexEntry,
} from "./storage-index.service";
import { projectLegacyWritebackArtifacts } from "./storage-legacy-projection.service";
import { normalizeMountOverlay } from "./storage-mount-overlay";
import type {
  StorageManifestCacheBranch,
  StorageManifestCacheEntryKind,
  SystemStoragePresignedUrlCacheStatus,
  WorkflowSkillStoragePresignedUrlCacheStatus,
} from "./system-storage-presigned-url-cache.service";

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly expectedStorageId?: string;
}

interface PrepareAgentRunStorageManifestArgs {
  readonly db: ReadonlyDb;
  readonly instructionsStorageName: string;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    readonly StorageManifestSource[] | undefined;
  readonly framework: SupportedFramework | "pi";
  /** Canonical session persistence replaces matching request writeback artifacts. */
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

interface ResolvedVolume {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly vasVersion: string;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
  readonly composeVolumes: readonly ResolvedVolume[];
}

interface BuildStorageManifestEntriesArgs {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly composeVolumes: readonly ResolvedVolume[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    readonly StorageManifestSource[] | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
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
  readonly compose: StorageManifestEntryPhaseTiming;
  readonly additional: StorageManifestEntryPhaseTiming;
  readonly artifact: StorageManifestEntryPhaseTiming;
}

interface ResolvedStorageEntries {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly branch: StorageManifestCacheBranch;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
  readonly resolved: ResolvedStorageManifestEntryPlans;
}

/** One immutable selection per attempt, including canonical session writeback. */
export interface ResolvedAgentRunStorage {
  readonly metadata: PreparedAgentRunStorage<StorageMountMetadata>;
  readonly requested: ResolvedStorageEntries;
  readonly sessionWriteback: ResolvedStorageEntries | undefined;
}

/** Read-only selection. Missing writeback roots are initialized by materialization. */
export interface AgentRunStoragePlan {
  readonly requested: ResolvedStorageEntries;
  readonly sessionWriteback: ResolvedStorageEntries | undefined;
  readonly missingArtifacts: readonly ContextArtifact[];
}

export interface MaterializedAgentRunStorage {
  readonly resolved: ResolvedAgentRunStorage;
  readonly prepared: PreparedAgentRunStorage;
}

interface ResolvedStorageManifestEntryPlans {
  readonly composePlans: readonly ResolvedManifestStoragePlan[];
  readonly additionalPlans: readonly ResolvedManifestStoragePlan[];
  readonly artifactInputs: readonly ResolvedManifestArtifactInput[];
}

interface ResolvedManifestStorageInput {
  readonly name: string;
  readonly mountPath: string;
  readonly vasStorageName: string;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly resolved: StorageResolution;
}

interface ResolvedManifestStoragePlan extends ResolvedManifestStorageInput {
  readonly entryKind: Extract<
    StorageManifestEntryKind,
    "compose" | "additional"
  >;
  readonly source: StorageManifestSource;
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
  private readonly generateWindow: StorageManifestPhaseTimingWindow = {
    startedAt: undefined,
    finishedAt: undefined,
  };

  constructor(
    private readonly timing: ApiDispatchTimingCollector | undefined,
    private readonly resolveActionType: ApiDispatchTimingActionType,
    private readonly generateActionType: ApiDispatchTimingActionType,
    private readonly resolveDimensions:
      ApiDispatchTimingDimensionsInput | undefined,
    private readonly generateDimensions:
      ApiDispatchTimingDimensionsInput | undefined,
  ) {}

  async measureResolve<T>(operation: () => T | Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  async measureGenerate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.generateWindow, operation);
  }

  flushResolve(): void {
    this.record(
      this.resolveActionType,
      this.resolveWindow,
      this.resolveDimensions,
    );
  }

  flushGenerate(): void {
    this.record(
      this.generateActionType,
      this.generateWindow,
      this.generateDimensions,
    );
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
    dimensions: ApiDispatchTimingDimensionsInput | undefined,
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
      dimensions,
    );
  }
}

function instructionsMountPath(framework: SupportedFramework | "pi"): string {
  if (framework === "pi") {
    return PI_AGENT_DIR;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_HOME_DIR
    : CANONICAL_CLAUDE_CONFIG_DIR;
}

function instructionsFilename(framework: SupportedFramework | "pi"): string {
  return framework === "pi" ? "AGENTS.md" : getInstructionsFilename(framework);
}

function runInstructionsVolume(args: {
  readonly instructionsStorageName: string;
  readonly framework: SupportedFramework | "pi";
}): ResolvedVolume {
  return {
    name: args.instructionsStorageName,
    mountPath: instructionsMountPath(args.framework),
    vasStorageName: args.instructionsStorageName,
    vasVersion: "latest",
    instructionsTargetFilename: instructionsFilename(args.framework),
  };
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

function storagePrefixVersionRequests(
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

function storageIndexWithPrefixVersions(
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

function isMissingStorageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("not found in database") ||
      error.message.includes("has no HEAD version"))
  );
}

function volumeStorageName(volume: ResolvedVolume | AdditionalVolume): string {
  return "vasStorageName" in volume ? volume.vasStorageName : volume.name;
}

function volumeVersion(
  volume: ResolvedVolume | AdditionalVolume,
): string | undefined {
  return "vasVersion" in volume ? volume.vasVersion : volume.version;
}

function volumeStorageLookup(
  orgId: string,
  volume: ResolvedVolume | AdditionalVolume,
): StorageLookup {
  return {
    orgId,
    userId: VOLUME_ORG_USER_ID,
    name: volumeStorageName(volume),
  };
}

function resolveVolumeStorage(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly volume: ResolvedVolume | AdditionalVolume;
  readonly primaryOrgId: string;
  readonly allowSystemFallback: boolean;
}): StorageResolution | null {
  if (args.allowSystemFallback && args.volume.system) {
    const systemResult = safeSync(() => {
      return resolveStorageVersion(
        args.index,
        volumeStorageLookup(SYSTEM_ORG_ID, args.volume),
        volumeVersion(args.volume),
      );
    });
    if ("ok" in systemResult) {
      return systemResult.ok;
    }
    if (!isMissingStorageError(systemResult.error)) {
      throw systemResult.error;
    }
  }

  return resolveStorageVersion(
    args.index,
    volumeStorageLookup(args.primaryOrgId, args.volume),
    volumeVersion(args.volume),
  );
}

function resolveComposeStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
}): ResolvedManifestStorageInput | null {
  const resolvedResult = safeSync(() => {
    return resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.agentOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (args.volume.optional && isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.vasStorageName,
    instructionsTargetFilename: args.volume.instructionsTargetFilename,
    optional: args.volume.optional,
    resolved: resolvedResult.ok,
  };
}

function resolveAdditionalStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
}): ResolvedManifestStorageInput | null {
  const { source } = args;
  if (source === "connector_skill" || source === "custom_connector_skill") {
    return resolveConnectorSkillStorageInput({
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
      source,
    });
  }
  if (source === "official_workflow") {
    return resolveOfficialWorkflowStorageInput({
      index: args.index,
      volume: args.volume,
    });
  }
  if (args.volume.expectedStorageId !== undefined) {
    throw new Error("Exact Storage identity is unavailable for this source");
  }
  const resolvedResult = safeSync(() => {
    return resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.runtimeOrgId,
      allowSystemFallback: true,
    });
  });
  if ("error" in resolvedResult) {
    if (isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.ok) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved: resolvedResult.ok,
  };
}

const CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Connector skill registration is unavailable";

const CUSTOM_CONNECTOR_SKILL_REGISTRATION_ERROR =
  "Custom connector skill registration is unavailable";

export class OfficialWorkflowArtifactResolutionError extends Error {
  constructor() {
    super("Official Workflow artifact registration is unavailable");
    this.name = "OfficialWorkflowArtifactResolutionError";
  }
}

type ConnectorSkillStorageSource = Extract<
  StorageManifestSource,
  "connector_skill" | "custom_connector_skill"
>;

function connectorSkillRegistrationError(
  source: ConnectorSkillStorageSource,
): Error {
  return new Error(
    source === "connector_skill"
      ? CONNECTOR_SKILL_REGISTRATION_ERROR
      : CUSTOM_CONNECTOR_SKILL_REGISTRATION_ERROR,
  );
}

function resolveConnectorSkillStorageInput(args: {
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: ConnectorSkillStorageSource;
}): ResolvedManifestStorageInput {
  const version = args.volume.version;
  if (
    (args.source === "connector_skill") !== (args.volume.system === true) ||
    version === undefined ||
    !/^[a-f0-9]{64}$/u.test(version)
  ) {
    throw connectorSkillRegistrationError(args.source);
  }

  const ownerOrgId =
    args.source === "connector_skill" ? SYSTEM_ORG_ID : args.runtimeOrgId;
  const lookup = volumeStorageLookup(ownerOrgId, args.volume);
  const storage = args.index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage) {
    throw connectorSkillRegistrationError(args.source);
  }
  const resolved = resolvePreloadedExactVersion(storage, lookup, version);
  if (!resolved) {
    throw connectorSkillRegistrationError(args.source);
  }

  const expectedKey = `${resolved.s3Prefix}/${version}`;
  if (
    resolved.s3Key !== expectedKey ||
    (args.source === "connector_skill" &&
      resolved.s3Prefix !== `${SYSTEM_ORG_ID}/volume/${args.volume.name}`)
  ) {
    throw connectorSkillRegistrationError(args.source);
  }

  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved,
  };
}

function resolveOfficialWorkflowStorageInput(args: {
  readonly index: StorageIndex;
  readonly volume: AdditionalVolume;
}): ResolvedManifestStorageInput {
  const version = args.volume.version;
  const expectedStorageId = args.volume.expectedStorageId;
  if (
    args.volume.system !== true ||
    expectedStorageId === undefined ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      expectedStorageId,
    ) ||
    version === undefined ||
    !/^[a-f0-9]{64}$/u.test(version)
  ) {
    throw new OfficialWorkflowArtifactResolutionError();
  }

  const lookup = volumeStorageLookup(SYSTEM_ORG_ID, args.volume);
  const storage = args.index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage || storage.storageId !== expectedStorageId) {
    throw new OfficialWorkflowArtifactResolutionError();
  }
  const resolved = resolvePreloadedExactVersion(storage, lookup, version);
  if (!resolved || resolved.storageId !== expectedStorageId) {
    throw new OfficialWorkflowArtifactResolutionError();
  }

  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    resolved,
  };
}

function resolveArtifactStorageInput(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
  readonly source: StorageManifestSource;
}): ResolvedManifestArtifactInput {
  const resolved = resolveStorageVersion(
    args.index,
    artifactStorageLookup(args.runtimeOrgId, args.userId, args.artifact.name),
    args.artifact.version,
  );
  return { artifact: args.artifact, resolved, source: args.source };
}

function readOnlyStorageEntryMetadata(args: {
  readonly plan: ResolvedManifestStoragePlan;
}): PreparedReadOnlyStorageEntry<StorageMountMetadata> {
  const archiveSize = knownArchiveSize(args.plan.resolved);
  return {
    storedMount: {
      orgId: args.plan.resolved.resolvedOrgId,
      userId: args.plan.resolved.resolvedUserId,
      name: args.plan.vasStorageName,
      storageId: args.plan.resolved.storageId,
      versionId: args.plan.resolved.versionId,
      mountPath: args.plan.mountPath,
      ...(archiveSize === undefined ? {} : { archiveSize }),
      ...(args.plan.instructionsTargetFilename
        ? {
            instructionsTargetFilename: args.plan.instructionsTargetFilename,
          }
        : {}),
    },
    persistedMount: {
      orgId: args.plan.resolved.resolvedOrgId,
      userId: args.plan.resolved.resolvedUserId,
      name: args.plan.vasStorageName,
      storageId: args.plan.resolved.storageId,
      version: args.plan.resolved.versionId,
      mountPath: args.plan.mountPath,
      ...(args.plan.optional === undefined
        ? {}
        : { optional: args.plan.optional }),
      ...(args.plan.instructionsTargetFilename === undefined
        ? {}
        : {
            instructionsTargetFilename: args.plan.instructionsTargetFilename,
          }),
    },
    runContextVolume: {
      name: args.plan.name,
      mountPath: args.plan.mountPath,
      vasStorageName: args.plan.vasStorageName,
      vasVersionId: args.plan.resolved.versionId,
    },
  };
}

async function buildComposeStorageEntry(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveComposeStorageInput({
      db: args.db,
      index: args.index,
      agentOrgId: args.agentOrgId,
      volume: args.volume,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("compose", "compose_volume");
  }
  return input
    ? { ...input, entryKind: "compose", source: "compose_volume" }
    : null;
}

async function buildAdditionalStorageEntry(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
  readonly phaseTiming: StorageManifestEntryPhaseTiming;
  readonly stats?: StorageManifestBuildStats;
}): Promise<ResolvedManifestStoragePlan | null> {
  const input = await args.phaseTiming.measureResolve(() => {
    return resolveAdditionalStorageInput({
      db: args.db,
      index: args.index,
      runtimeOrgId: args.runtimeOrgId,
      volume: args.volume,
      source: args.source,
    });
  });
  if (input) {
    args.stats?.recordResolvedEntry("additional", args.source);
  }
  return input
    ? { ...input, entryKind: "additional", source: args.source }
    : null;
}

function additionalVolumeSourceAt(
  sources: readonly StorageManifestSource[] | undefined,
  index: number,
): StorageManifestSource {
  return sources?.[index] ?? "unknown";
}

function normalizeAdditionalVolumeSources(args: {
  readonly volumes: readonly AdditionalVolume[] | undefined;
  readonly sources: readonly StorageManifestSource[] | undefined;
}): readonly StorageManifestSource[] | undefined {
  if (!args.sources) {
    return undefined;
  }
  if (args.sources.length !== (args.volumes?.length ?? 0)) {
    throw new Error(
      "Additional volume source count must match additional volume count",
    );
  }
  return args.sources;
}

export async function resolveStorageManifestInputs(
  args: PrepareAgentRunStorageManifestArgs,
): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
        composeVolumes: [runInstructionsVolume(args)],
      };
    },
  );
}

function storageManifestRequests(args: {
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly composeVolumes: readonly ResolvedVolume[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    readonly StorageManifestSource[] | undefined;
  readonly artifacts: readonly ContextArtifact[];
}): readonly StorageRequest[] {
  const requests: StorageRequest[] = [];

  for (const volume of args.composeVolumes) {
    const version = volumeVersion(volume);
    if (volume.system) {
      requests.push({
        lookup: volumeStorageLookup(SYSTEM_ORG_ID, volume),
        version,
      });
    }
    requests.push({
      lookup: volumeStorageLookup(args.agentOrgId, volume),
      version,
    });
  }
  for (const [index, volume] of (args.additionalVolumes ?? []).entries()) {
    const version = volumeVersion(volume);
    const source = additionalVolumeSourceAt(
      args.additionalVolumeSources,
      index,
    );
    if (
      source === "connector_skill" ||
      source === "custom_connector_skill" ||
      source === "official_workflow"
    ) {
      requests.push({
        lookup: volumeStorageLookup(
          source === "connector_skill" || source === "official_workflow"
            ? SYSTEM_ORG_ID
            : args.runtimeOrgId,
          volume,
        ),
        version,
      });
      continue;
    }
    if (volume.system) {
      requests.push({
        lookup: volumeStorageLookup(SYSTEM_ORG_ID, volume),
        version,
      });
    }
    requests.push({
      lookup: volumeStorageLookup(args.runtimeOrgId, volume),
      version,
    });
  }
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
  readonly stats?: StorageManifestBuildStats;
}): StorageManifestEntryPhaseTimings {
  return {
    compose: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_compose_versions",
      "api_dispatch_prepare_storage_manifest_generate_compose_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("compose");
      },
    ),
    additional: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_additional_versions",
      "api_dispatch_prepare_storage_manifest_generate_additional_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("additional");
      },
    ),
    artifact: new StorageManifestEntryPhaseTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_artifact_versions",
      "api_dispatch_prepare_storage_manifest_generate_artifact_urls",
      undefined,
      () => {
        return args.stats?.generateDimensions("artifact");
      },
    ),
  };
}

function isResolvedManifestStoragePlan(
  plan: ResolvedManifestStoragePlan | null,
): plan is ResolvedManifestStoragePlan {
  return plan !== null;
}

async function resolveStorageManifestEntryPlans(args: {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
}): Promise<ResolvedStorageManifestEntryPlans> {
  const input = args.input;
  const [composePlans, additionalPlans, artifactInputs] = await Promise.all([
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_compose_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.composeVolumes.map((volume) => {
            return buildComposeStorageEntry({
              db: input.db,
              index: input.storageIndex,
              agentOrgId: input.agentOrgId,
              volume,
              phaseTiming: args.phaseTimings.compose,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_additional_entries",
      "nested",
      async () => {
        return await Promise.all(
          (input.additionalVolumes ?? []).map((volume, index) => {
            return buildAdditionalStorageEntry({
              db: input.db,
              index: input.storageIndex,
              runtimeOrgId: input.runtimeOrgId,
              volume,
              source: additionalVolumeSourceAt(
                input.additionalVolumeSources,
                index,
              ),
              phaseTiming: args.phaseTimings.additional,
              stats: input.stats,
            });
          }),
        );
      },
    ),
    measureApiDispatchTiming(
      input.timing,
      "api_dispatch_prepare_storage_manifest_build_artifact_entries",
      "nested",
      async () => {
        return await Promise.all(
          input.artifacts.map((artifact) => {
            return args.phaseTimings.artifact.measureResolve(() => {
              return resolveArtifactStorageInput({
                db: input.db,
                index: input.storageIndex,
                runtimeOrgId: input.runtimeOrgId,
                userId: input.userId,
                artifact,
                source: "artifact",
              });
            });
          }),
        );
      },
    ),
  ]);

  input.stats?.recordResolvedEntry(
    "artifact",
    "artifact",
    artifactInputs.length,
  );

  return {
    composePlans: composePlans.filter(isResolvedManifestStoragePlan),
    additionalPlans: additionalPlans.filter(isResolvedManifestStoragePlan),
    artifactInputs,
  };
}

export async function resolveStorageEntries(
  input: BuildStorageManifestEntriesArgs,
  branch: StorageManifestCacheBranch,
): Promise<ResolvedStorageEntries> {
  const phaseTimings = createStorageManifestEntryPhaseTimings(input);
  const resolved = await resolveStorageManifestEntryPlans({
    input,
    phaseTimings,
  }).finally(() => {
    phaseTimings.compose.flushResolve();
    phaseTimings.additional.flushResolve();
    phaseTimings.artifact.flushResolve();
  });
  return { input, branch, phaseTimings, resolved };
}

/** Assemble runner mounts from immutable version plans and already signed URLs. */
export function storageEntriesMetadata(
  plan: ResolvedStorageEntries,
): PreparedStorageEntries<StorageMountMetadata> {
  const finalPlans = mergeStorageEntries({
    composeEntries: plan.resolved.composePlans,
    additionalEntries: plan.resolved.additionalPlans,
    mountPath: (entry) => {
      return entry.mountPath;
    },
  });
  return {
    composeEntries: finalPlans
      .filter((entry) => {
        return entry.entryKind === "compose";
      })
      .map((entry) => {
        return readOnlyStorageEntryMetadata({ plan: entry });
      }),
    additionalEntries: finalPlans
      .filter((entry) => {
        return entry.entryKind === "additional";
      })
      .map((entry) => {
        return readOnlyStorageEntryMetadata({ plan: entry });
      }),
    writebackEntries: plan.resolved.artifactInputs.map(
      writebackStorageEntryMetadata,
    ),
    resolvedComposeEntryCount: plan.resolved.composePlans.length,
    resolvedAdditionalEntryCount: plan.resolved.additionalPlans.length,
  };
}

function persistedMountIdentity(
  mount: Pick<PersistedStorageMount, "name" | "mountPath">,
): string {
  return JSON.stringify([mount.name, mount.mountPath]);
}

export function assertUniquePersistedMountPaths(
  mounts: readonly PersistedStorageMount[],
): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (paths.has(mount.mountPath)) {
      throw new Error(`Duplicate Storage mount path "${mount.mountPath}"`);
    }
    paths.add(mount.mountPath);
  }
}

export function persistedStorageMountRequests(
  mounts: readonly PersistedStorageMount[],
): readonly StorageRequest[] {
  return mounts.map((mount) => {
    return {
      lookup: {
        orgId: mount.orgId,
        userId: mount.userId,
        name: mount.name,
      },
      version: mount.version,
    };
  });
}

function resolvePersistedStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly index: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
}): ResolvedStorageManifestEntryPlans {
  const additionalPlans: ResolvedManifestStoragePlan[] = [];
  const artifactInputs: ResolvedManifestArtifactInput[] = [];

  for (const mount of args.mounts) {
    if (mount.writeback && mount.orgId === SYSTEM_ORG_ID) {
      throw new Error("System Storage cannot be mounted with writeback");
    }
    const lookup: StorageLookup = {
      orgId: mount.orgId,
      userId: mount.userId,
      name: mount.name,
    };
    const storage = args.index.get(
      storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
    );
    if (!storage) {
      if (mount.optional) {
        continue;
      }
      throw new Error(`Storage "${mount.name}" not found in database`);
    }
    if (storage.storageId !== mount.storageId) {
      throw new Error(`Storage "${mount.name}" identity does not match`);
    }

    const resolvedResult = safeSync(() => {
      return resolveStorageVersion(args.index, lookup, mount.version);
    });
    if ("error" in resolvedResult) {
      if (mount.optional && isMissingStorageError(resolvedResult.error)) {
        continue;
      }
      throw resolvedResult.error;
    }
    const resolved = resolvedResult.ok;

    if (mount.writeback) {
      artifactInputs.push({
        artifact: {
          name: mount.name,
          version: mount.version,
          mountPath: mount.mountPath,
          ...(mount.missingRootPolicy === undefined
            ? {}
            : { missingRootPolicy: mount.missingRootPolicy }),
        },
        resolved,
        source: "artifact",
      });
      continue;
    }

    additionalPlans.push({
      name: mount.name,
      vasStorageName: mount.name,
      mountPath: mount.mountPath,
      ...(mount.optional === undefined ? {} : { optional: mount.optional }),
      ...(mount.instructionsTargetFilename === undefined
        ? {}
        : {
            instructionsTargetFilename: mount.instructionsTargetFilename,
          }),
      resolved,
      entryKind: "additional",
      source: "unknown",
    });
  }

  return { composePlans: [], additionalPlans, artifactInputs };
}

export function resolveValidatedPersistedStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
  readonly branch: Extract<
    StorageManifestCacheBranch,
    "session_writeback" | "captured"
  >;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): ResolvedStorageEntries {
  const phaseTimings = createStorageManifestEntryPhaseTimings(args);
  const result = safeSync(() => {
    const input: BuildStorageManifestEntriesArgs = {
      db: args.db,
      bucket: args.bucket,
      storageIndex: args.storageIndex,
      agentOrgId: "",
      runtimeOrgId: "",
      userId: "",
      composeVolumes: [],
      additionalVolumes: undefined,
      additionalVolumeSources: undefined,
      artifacts: [],
      timing: args.timing,
      stats: args.stats,
    };
    const resolved = resolvePersistedStorageMounts({
      db: args.db,
      index: args.storageIndex,
      mounts: args.mounts,
    });
    args.stats?.recordResolvedEntry(
      "additional",
      "unknown",
      resolved.additionalPlans.length,
    );
    args.stats?.recordResolvedEntry(
      "artifact",
      "artifact",
      resolved.artifactInputs.length,
    );
    return { input, branch: args.branch, phaseTimings, resolved };
  });
  phaseTimings.compose.flushResolve();
  phaseTimings.additional.flushResolve();
  phaseTimings.artifact.flushResolve();
  if ("error" in result) {
    throw result.error;
  }
  return result.ok;
}

export function resolveSessionWritebackStorageMounts(args: {
  readonly db: ReadonlyDb;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): ResolvedStorageEntries {
  assertUniquePersistedMountPaths(args.mounts);
  return resolveValidatedPersistedStorageMounts({
    ...args,
    branch: "session_writeback",
  });
}

export function combinePreparedStorageEntries<
  TMount extends StorageMountMetadata,
>(args: {
  readonly requested: PreparedStorageEntries<TMount>;
  readonly sessionWriteback: PreparedStorageEntries<TMount>;
}): PreparedStorageEntries<TMount> {
  return {
    composeEntries: args.requested.composeEntries,
    additionalEntries: [
      ...args.requested.additionalEntries,
      ...args.sessionWriteback.additionalEntries,
    ],
    writebackEntries: [
      ...args.requested.writebackEntries,
      ...args.sessionWriteback.writebackEntries,
    ],
    resolvedComposeEntryCount: args.requested.resolvedComposeEntryCount,
    resolvedAdditionalEntryCount:
      args.requested.resolvedAdditionalEntryCount +
      args.sessionWriteback.resolvedAdditionalEntryCount,
  };
}

interface SessionStorageOverlay {
  readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
  readonly remainingArtifacts: readonly ContextArtifact[];
}

export function resolveSessionStorageOverlay(args: {
  readonly artifacts: readonly ContextArtifact[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[] | undefined;
}): SessionStorageOverlay {
  const canonicalWritebackByIdentity = new Map(
    (args.persistedStorageMounts ?? []).map((mount) => {
      if (!mount.writeback) {
        throw new Error(
          "Session Storage persistence may only contain writeback mounts",
        );
      }
      return [persistedMountIdentity(mount), mount] as const;
    }),
  );
  const canonicalWritebackMounts = args.artifacts.flatMap((artifact) => {
    const mount = canonicalWritebackByIdentity.get(
      persistedMountIdentity(artifact),
    );
    if (!mount) {
      return [];
    }
    const {
      version: _storedVersion,
      missingRootPolicy: _storedMissingRootPolicy,
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
  const remainingArtifacts = args.artifacts.filter((artifact) => {
    return !canonicalWritebackByIdentity.has(persistedMountIdentity(artifact));
  });
  return { canonicalWritebackMounts, remainingArtifacts };
}

export function prepareRequestStorageResolution(
  args: PrepareAgentRunStorageManifestArgs,
  bucket: string,
  composeVolumes: readonly ResolvedVolume[],
  artifacts: readonly ContextArtifact[],
): PreparedRequestStorageResolution {
  const additionalVolumeSources = normalizeAdditionalVolumeSources({
    volumes: args.additionalVolumes,
    sources: args.additionalVolumeSources,
  });
  args.stats?.recordRequestedInputs({
    composeCount: composeVolumes.length,
    additionalCount: args.additionalVolumes?.length ?? 0,
    artifactCount: args.artifacts.length,
    dedupedArtifactCount: artifacts.length,
  });

  const input: UnindexedStorageManifestEntriesArgs = {
    db: args.db,
    bucket,
    agentOrgId: args.agentOrgId,
    runtimeOrgId: args.runtimeOrgId,
    userId: args.userId,
    composeVolumes,
    additionalVolumes: args.additionalVolumes,
    additionalVolumeSources,
    artifacts,
    timing: args.timing,
    stats: args.stats,
  };
  return {
    input,
    requests: storageManifestRequests(input),
  };
}

interface CapturedAgentRunStorageArgs {
  readonly db: ReadonlyDb;
  readonly mounts: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

export type AgentRunStorageInput =
  | {
      readonly kind: "requested";
      readonly args: PrepareAgentRunStorageManifestArgs;
    }
  | { readonly kind: "captured"; readonly args: CapturedAgentRunStorageArgs };

export type AgentRunStorageSelection =
  | {
      readonly kind: "requested";
      readonly args: PrepareAgentRunStorageManifestArgs;
      readonly bucket: string;
      readonly request: PreparedRequestStorageResolution;
      readonly remainingArtifacts: readonly ContextArtifact[];
      readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
      readonly requests: readonly StorageRequest[];
    }
  | {
      readonly kind: "captured";
      readonly args: CapturedAgentRunStorageArgs;
      readonly bucket: string;
      readonly requests: readonly StorageRequest[];
    };

function frameworkSkillsMountPath(framework: SupportedFramework): string {
  return framework === "codex"
    ? `${CANONICAL_CODEX_HOME_DIR}/skills`
    : `${CANONICAL_CLAUDE_CONFIG_DIR}/skills`;
}

export function resolvedSessionStorage(session: {
  readonly id: string;
  readonly storageMounts: readonly PersistedStorageMount[] | null;
}): Pick<ResolvedAgentExecution, "artifacts" | "persistedStorageMounts"> {
  if (session.storageMounts === null) {
    throw new Error(
      `Agent session "${session.id}" is missing canonical Storage mounts`,
    );
  }
  return {
    artifacts: projectLegacyWritebackArtifacts(session.storageMounts),
    persistedStorageMounts: session.storageMounts,
  };
}

function skillsRootForRun(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  return piSandbox === undefined
    ? frameworkSkillsMountPath(framework)
    : PI_SKILLS_ROOT;
}

export type RunStorageExecution = Pick<
  ResolvedRunExecution,
  | "orgId"
  | "instructionsStorageName"
  | "artifacts"
  | "agentSessionId"
  | "persistedStorageMounts"
  | "additionalVolumes"
>;

/**
 * Shared storage index read: storage rows with their HEAD and exact requested
 * versions in one fixed-shape statement. Prefix versions are a separate read
 * ({@link withStoragePrefixVersions}) so callers can depend on this snapshot.
 */
export async function loadStorageBaseIndex(
  db: ReadonlyDb,
  requests: readonly StorageRequest[],
  timing: ApiDispatchTimingCollector | undefined,
): Promise<StorageIndex> {
  return await measureApiDispatchTiming(
    timing,
    "api_dispatch_prepare_storage_manifest_load_storage_index",
    "nested",
    () => {
      return readStorageBaseIndex(db, requests);
    },
  );
}

/** Resolve requested version prefixes against an already loaded index. */
export async function withStoragePrefixVersions(
  db: ReadonlyDb,
  requests: readonly StorageRequest[],
  index: StorageIndex,
): Promise<StorageIndex> {
  const queries = storagePrefixVersionRequests(requests, index).map(
    (request) => {
      return db
        .select({
          storageId: storageVersions.storageId,
          id: storageVersions.id,
          s3Key: storageVersions.s3Key,
          archiveSize: storageVersions.archiveSize,
          fileCount: storageVersions.fileCount,
          cacheKey: systemStoragePresignedUrlCache.cacheKey,
          cacheScope: systemStoragePresignedUrlCache.scope,
          presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
          expiresAt: systemStoragePresignedUrlCache.expiresAt,
        })
        .from(storageVersions)
        .leftJoin(
          systemStoragePresignedUrlCache,
          eq(
            systemStoragePresignedUrlCache.cacheKey,
            storageVersionCacheKeySql({
              orgId: sql`${request.lookup.orgId}`,
              userId: sql`${request.lookup.userId}`,
              name: sql`${request.lookup.name}`,
              versionId: sql`${storageVersions.id}`,
              s3Key: sql`${storageVersions.s3Key}`,
            }),
          ),
        )
        .where(
          and(
            eq(storageVersions.storageId, request.storageId),
            or(
              eq(storageVersions.id, request.version),
              isValidVersionPrefix(request.version)
                ? like(storageVersions.id, `${request.version}%`)
                : undefined,
            ),
          ),
        )
        .orderBy(desc(eq(storageVersions.id, request.version)))
        .limit(2);
    },
  );
  const [first, second, ...remaining] = queries;
  const versions = first
    ? await (second ? unionAll(first, second, ...remaining) : first)
    : [];
  return storageIndexWithPrefixVersions(index, versions);
}

export interface AgentRunCreateAdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly expectedStorageId?: string;
}

type StorageManifestSource =
  | SkillVolume["source"]
  | "compose_additional_volume"
  | "compose_volume"
  | "artifact"
  | "unknown";

export type AdditionalVolumeSources =
  readonly StorageManifestSource[] | undefined;

export interface ResolvedAgentExecution {
  readonly instructionsStorageName: string;
  readonly agentId: string;
  readonly ownerUserId: string;
  readonly orgId: string;
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes?: readonly AgentRunCreateAdditionalVolume[];
  readonly persistedStorageMounts?: readonly PersistedStorageMount[];
  readonly agentSessionId?: string;
  readonly continuedFromAgentSessionId?: string;
  readonly resumeSession?: StoredExecutionContext["resumeSession"];
  readonly resumeSessionIdentity?: SessionExecutionIdentity;
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

interface PreparedAdditionalVolumes {
  readonly volumes: readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly sources: AdditionalVolumeSources;
}

function autoMemoryMountPath(
  framework: SupportedFramework,
  piSandbox: PiModelConfig | undefined,
): string {
  if (piSandbox !== undefined) {
    return PI_MEMORY_ROOT;
  }
  return framework === "codex"
    ? CANONICAL_CODEX_MEMORY_MOUNT_PATH
    : CANONICAL_CLAUDE_MEMORY_MOUNT_PATH;
}

function artifactsForRun(args: {
  readonly resolved: Pick<ResolvedRunExecution, "artifacts">;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
}): RunArtifacts {
  return {
    artifacts: [
      ...args.resolved.artifacts.filter((artifact) => {
        return (
          artifact.name !== AUTO_MEMORY_ARTIFACT_NAME &&
          artifact.mountPath !==
            autoMemoryMountPath(args.framework, args.piSandbox)
        );
      }),
      {
        name: AUTO_MEMORY_ARTIFACT_NAME,
        mountPath: autoMemoryMountPath(args.framework, args.piSandbox),
        missingRootPolicy: AUTO_MEMORY_MISSING_ROOT_POLICY,
      },
    ],
  };
}

function preparedRunAdditionalVolumes(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly skillsRoot: string;
  readonly body: {
    readonly additionalVolumes?: readonly AgentRunCreateAdditionalVolume[];
  };
  readonly resolved: Pick<ResolvedRunExecution, "additionalVolumes">;
}): PreparedAdditionalVolumes {
  const bodyAdditionalVolumes = args.body.additionalVolumes;
  const rendered = resolveRunSkillVolumes(args.skillVolumes, args.skillsRoot);
  const hasTemplateVolumes = args.skillVolumes.some((volume) => {
    return volume.source === "request_additional_volume";
  });
  const additionalVolumes =
    bodyAdditionalVolumes ??
    (hasTemplateVolumes ? [] : (args.resolved.additionalVolumes ?? []));
  return {
    volumes: [...rendered.skillVolumes, ...additionalVolumes],
    sources: [
      ...rendered.skillVolumeSources,
      ...additionalVolumes.map((): StorageManifestSource => {
        return bodyAdditionalVolumes ? "request_additional_volume" : "unknown";
      }),
    ],
  };
}

export function prepareRunOutputMetadata(args: {
  readonly skillVolumes: readonly SkillVolume[];
  readonly officialWorkflow: OfficialWorkflowObservation | undefined;
  readonly framework: SupportedFramework;
  readonly piSandbox: PiModelConfig | undefined;
  readonly body: {
    readonly additionalVolumes?: readonly AgentRunCreateAdditionalVolume[];
  };
  readonly resolved: RunStorageExecution;
}): {
  readonly artifacts: readonly AgentRunCreateContextArtifact[];
  readonly additionalVolumes:
    readonly AgentRunCreateAdditionalVolume[] | undefined;
  readonly additionalVolumeSources: AdditionalVolumeSources;
  readonly officialWorkflowRun: OfficialWorkflowRunObservation | undefined;
} {
  const skillsRoot = skillsRootForRun(args.framework, args.piSandbox);
  const additionalVolumes = preparedRunAdditionalVolumes({
    skillVolumes: args.skillVolumes,
    skillsRoot,
    body: args.body,
    resolved: args.resolved,
  });
  const artifacts = artifactsForRun({
    resolved: args.resolved,
    framework: args.framework,
    piSandbox: args.piSandbox,
  }).artifacts;
  return {
    additionalVolumes: additionalVolumes.volumes,
    additionalVolumeSources: additionalVolumes.sources,
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

export type ArtifactMissingRootPolicy = NonNullable<
  StorageMountEntry["missingRootPolicy"]
>;

export interface AgentRunCreateContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: ArtifactMissingRootPolicy;
}

type StorageManifestEntryKind = StorageManifestCacheEntryKind;

type StorageManifestCountBucket =
  (typeof STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS)[number];

interface PresignCandidateInput {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly filename: string | undefined;
  readonly usePublicEndpoint: boolean;
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

interface PreparedReadOnlyStorageEntry<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storedMount: TMount;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextVolume: RunContextResponse["volumes"][number];
}

interface PreparedWritebackStorageEntry<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storedMount: TMount;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextArtifact: NonNullable<RunContextResponse["artifact"]>;
}

interface PreparedStorageEntries<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly composeEntries: readonly PreparedReadOnlyStorageEntry<TMount>[];
  readonly additionalEntries: readonly PreparedReadOnlyStorageEntry<TMount>[];
  readonly writebackEntries: readonly PreparedWritebackStorageEntry<TMount>[];
  readonly resolvedComposeEntryCount: number;
  readonly resolvedAdditionalEntryCount: number;
}

interface RunContextStorageObservation {
  readonly volumes: RunContextResponse["volumes"];
  readonly artifact: RunContextResponse["artifact"];
}

export interface PreparedAgentRunStorage<
  TMount extends StorageMountMetadata = StoredStorageMountEntry,
> {
  readonly storageMounts: readonly TMount[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: RunContextStorageObservation;
}

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
  readonly source: StorageManifestSource;
}

const STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS = [
  "0",
  "1",
  "2_4",
  "5_8",
  "9_16",
  "17_plus",
] as const;

const STORAGE_MANIFEST_SOURCES = [
  "system_skill",
  "connector_skill",
  "custom_connector_skill",
  "official_workflow",
  "workflow_skill",
  "request_additional_volume",
  "compose_additional_volume",
  "compose_volume",
  "artifact",
  "unknown",
] as const satisfies readonly StorageManifestSource[];

type StorageManifestSourceCounts = Record<StorageManifestSource, number>;

type StorageManifestSourceCountsByKind = Record<
  StorageManifestEntryKind,
  StorageManifestSourceCounts
>;

function storageManifestCountBucket(count: number): StorageManifestCountBucket {
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

function emptyStorageManifestSourceCounts(): StorageManifestSourceCounts {
  return {
    system_skill: 0,
    connector_skill: 0,
    custom_connector_skill: 0,
    official_workflow: 0,
    workflow_skill: 0,
    request_additional_volume: 0,
    compose_additional_volume: 0,
    compose_volume: 0,
    artifact: 0,
    unknown: 0,
  };
}

function emptyStorageManifestSourceCountsByKind(): StorageManifestSourceCountsByKind {
  return {
    compose: emptyStorageManifestSourceCounts(),
    additional: emptyStorageManifestSourceCounts(),
    artifact: emptyStorageManifestSourceCounts(),
  };
}

export class StorageManifestBuildStats {
  private requestedComposeCount = 0;
  private requestedAdditionalCount = 0;
  private requestedArtifactCount = 0;
  private dedupedArtifactCount = 0;
  private resolvedComposeCount = 0;
  private resolvedAdditionalCount = 0;
  private resolvedArtifactCount = 0;
  private finalStorageCount = 0;
  private finalArtifactCount = 0;
  private droppedComposeCount = 0;
  private plannedComposePresignCount = 0;
  private plannedAdditionalPresignCount = 0;
  private plannedArtifactPresignCount = 0;
  private systemResolvedStorageCount = 0;
  private systemPresignCacheHitCount = 0;
  private systemPresignCacheMissCount = 0;
  private workflowSkillPresignCacheHitCount = 0;
  private workflowSkillPresignCacheMissCount = 0;
  private nonSystemPresignCount = 0;
  private readonly resolvedSourceCounts = emptyStorageManifestSourceCounts();
  private readonly plannedPresignSourceCounts =
    emptyStorageManifestSourceCounts();
  private readonly plannedPresignSourceCountsByKind =
    emptyStorageManifestSourceCountsByKind();
  private readonly nonSystemPresignSourceCounts =
    emptyStorageManifestSourceCounts();
  private readonly nonSystemPresignSourceCountsByKind =
    emptyStorageManifestSourceCountsByKind();
  private artifactEnsureAlreadyInitializedCount = 0;
  private artifactEnsureMissingStorageCount = 0;
  private artifactEnsureCreatedStorageCount = 0;
  private artifactEnsureLostCreateRaceCount = 0;
  private artifactEnsureMissingHeadVersionCount = 0;
  private artifactEnsureInitializedEmptyVersionCount = 0;
  private readonly presignCandidateCounts = new Map<string, number>();

  recordRequestedInputs(args: {
    readonly composeCount: number;
    readonly additionalCount: number;
    readonly artifactCount: number;
    readonly dedupedArtifactCount: number;
  }): void {
    this.requestedComposeCount = args.composeCount;
    this.requestedAdditionalCount = args.additionalCount;
    this.requestedArtifactCount = args.artifactCount;
    this.dedupedArtifactCount = args.dedupedArtifactCount;
  }

  recordResolvedEntry(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
    count = 1,
  ): void {
    switch (kind) {
      case "compose": {
        this.resolvedComposeCount += count;
        break;
      }
      case "additional": {
        this.resolvedAdditionalCount += count;
        break;
      }
      case "artifact": {
        this.resolvedArtifactCount += count;
        break;
      }
    }
    this.resolvedSourceCounts[source] += count;
  }

  recordPresignCandidate(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
    input: PresignCandidateInput,
  ): void {
    switch (kind) {
      case "compose": {
        this.plannedComposePresignCount += 1;
        break;
      }
      case "additional": {
        this.plannedAdditionalPresignCount += 1;
        break;
      }
      case "artifact": {
        this.plannedArtifactPresignCount += 1;
        break;
      }
    }
    this.plannedPresignSourceCounts[source] += 1;
    this.plannedPresignSourceCountsByKind[kind][source] += 1;

    const key = JSON.stringify([
      input.bucket,
      input.key,
      input.expiresIn,
      input.filename ?? "",
      input.usePublicEndpoint ? "public" : "private",
    ]);
    this.presignCandidateCounts.set(
      key,
      (this.presignCandidateCounts.get(key) ?? 0) + 1,
    );
  }

  recordSystemResolvedStorage(count = 1): void {
    this.systemResolvedStorageCount += count;
  }

  recordSystemPresignCacheResult(
    status: SystemStoragePresignedUrlCacheStatus,
  ): void {
    switch (status) {
      case "hit": {
        this.systemPresignCacheHitCount += 1;
        return;
      }
      case "miss": {
        this.systemPresignCacheMissCount += 1;
        return;
      }
    }
  }

  recordWorkflowSkillPresignCacheResult(
    status: WorkflowSkillStoragePresignedUrlCacheStatus,
  ): void {
    switch (status) {
      case "hit": {
        this.workflowSkillPresignCacheHitCount += 1;
        return;
      }
      case "miss": {
        this.workflowSkillPresignCacheMissCount += 1;
        return;
      }
    }
  }

  recordNonSystemPresign(
    kind: StorageManifestEntryKind,
    source: StorageManifestSource,
  ): void {
    this.nonSystemPresignCount += 1;
    this.nonSystemPresignSourceCounts[source] += 1;
    this.nonSystemPresignSourceCountsByKind[kind][source] += 1;
  }

  recordArtifactEnsureAlreadyInitialized(): void {
    this.artifactEnsureAlreadyInitializedCount += 1;
  }

  recordArtifactEnsureMissingStorage(): void {
    this.artifactEnsureMissingStorageCount += 1;
  }

  recordArtifactEnsureCreatedStorage(): void {
    this.artifactEnsureCreatedStorageCount += 1;
  }

  recordArtifactEnsureLostCreateRace(): void {
    this.artifactEnsureLostCreateRaceCount += 1;
  }

  recordArtifactEnsureMissingHeadVersion(): void {
    this.artifactEnsureMissingHeadVersionCount += 1;
  }

  recordArtifactEnsureInitializedEmptyVersion(): void {
    this.artifactEnsureInitializedEmptyVersionCount += 1;
  }

  recordFinalStorage(args: {
    readonly composeEntryCount: number;
    readonly additionalEntryCount: number;
    readonly finalReadOnlyEntryCount: number;
    readonly finalWritebackEntryCount: number;
    readonly resolvedComposeEntryCount?: number;
    readonly resolvedAdditionalEntryCount?: number;
  }): void {
    this.finalStorageCount = args.finalReadOnlyEntryCount;
    this.finalArtifactCount = args.finalWritebackEntryCount;
    this.droppedComposeCount =
      (args.resolvedComposeEntryCount ?? args.composeEntryCount) +
      (args.resolvedAdditionalEntryCount ?? args.additionalEntryCount) -
      args.finalReadOnlyEntryCount;
  }

  overallDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_requested_compose_count_bucket:
        storageManifestCountBucket(this.requestedComposeCount),
      storage_manifest_requested_additional_count_bucket:
        storageManifestCountBucket(this.requestedAdditionalCount),
      storage_manifest_requested_artifact_count_bucket:
        storageManifestCountBucket(this.requestedArtifactCount),
      storage_manifest_deduped_artifact_count_bucket:
        storageManifestCountBucket(this.dedupedArtifactCount),
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.sourceDimensions({
        resolved: this.resolvedSourceCounts,
        plannedPresign: this.plannedPresignSourceCounts,
        nonSystemPresign: this.nonSystemPresignSourceCounts,
      }),
      ...this.systemPresignCacheDimensions(),
      ...this.workflowSkillPresignCacheDimensions(),
      ...this.artifactEnsureDimensions(),
    };
  }

  artifactEnsureDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_artifact_ensure_already_initialized_count_bucket:
        storageManifestCountBucket(this.artifactEnsureAlreadyInitializedCount),
      storage_manifest_artifact_ensure_missing_storage_count_bucket:
        storageManifestCountBucket(this.artifactEnsureMissingStorageCount),
      storage_manifest_artifact_ensure_created_storage_count_bucket:
        storageManifestCountBucket(this.artifactEnsureCreatedStorageCount),
      storage_manifest_artifact_ensure_lost_create_race_count_bucket:
        storageManifestCountBucket(this.artifactEnsureLostCreateRaceCount),
      storage_manifest_artifact_ensure_missing_head_version_count_bucket:
        storageManifestCountBucket(this.artifactEnsureMissingHeadVersionCount),
      storage_manifest_artifact_ensure_initialized_empty_version_count_bucket:
        storageManifestCountBucket(
          this.artifactEnsureInitializedEmptyVersionCount,
        ),
    };
  }

  buildEntriesDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_resolved_compose_count_bucket:
        storageManifestCountBucket(this.resolvedComposeCount),
      storage_manifest_resolved_additional_count_bucket:
        storageManifestCountBucket(this.resolvedAdditionalCount),
      storage_manifest_resolved_artifact_count_bucket:
        storageManifestCountBucket(this.resolvedArtifactCount),
      storage_manifest_planned_presign_count_bucket: storageManifestCountBucket(
        this.plannedPresignCount(),
      ),
      storage_manifest_duplicate_presign_candidate_count_bucket:
        storageManifestCountBucket(this.duplicatePresignCandidateCount()),
      ...this.sourceDimensions({
        resolved: this.resolvedSourceCounts,
        plannedPresign: this.plannedPresignSourceCounts,
        nonSystemPresign: this.nonSystemPresignSourceCounts,
      }),
      ...this.systemPresignCacheDimensions(),
      ...this.workflowSkillPresignCacheDimensions(),
    };
  }

  generateDimensions(
    kind: StorageManifestEntryKind,
  ): ApiDispatchTimingDimensions {
    switch (kind) {
      case "compose": {
        return {
          storage_manifest_compose_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedComposePresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.compose,
            nonSystemPresign: this.nonSystemPresignSourceCountsByKind.compose,
          }),
        };
      }
      case "additional": {
        return {
          storage_manifest_additional_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedAdditionalPresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.additional,
            nonSystemPresign:
              this.nonSystemPresignSourceCountsByKind.additional,
          }),
          ...this.workflowSkillPresignCacheDimensions(),
        };
      }
      case "artifact": {
        return {
          storage_manifest_artifact_planned_presign_count_bucket:
            storageManifestCountBucket(this.plannedArtifactPresignCount),
          ...this.sourceDimensions({
            plannedPresign: this.plannedPresignSourceCountsByKind.artifact,
            nonSystemPresign: this.nonSystemPresignSourceCountsByKind.artifact,
          }),
        };
      }
    }
  }

  assembleDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_final_storage_count_bucket: storageManifestCountBucket(
        this.finalStorageCount,
      ),
      storage_manifest_final_artifact_count_bucket: storageManifestCountBucket(
        this.finalArtifactCount,
      ),
      storage_manifest_dropped_compose_count_bucket: storageManifestCountBucket(
        this.droppedComposeCount,
      ),
    };
  }

  private plannedPresignCount(): number {
    return (
      this.plannedComposePresignCount +
      this.plannedAdditionalPresignCount +
      this.plannedArtifactPresignCount
    );
  }

  private duplicatePresignCandidateCount(): number {
    let count = 0;
    for (const candidateCount of this.presignCandidateCounts.values()) {
      count += Math.max(0, candidateCount - 1);
    }
    return count;
  }

  private sourceDimensions(args: {
    readonly resolved?: StorageManifestSourceCounts;
    readonly plannedPresign?: StorageManifestSourceCounts;
    readonly nonSystemPresign?: StorageManifestSourceCounts;
  }): ApiDispatchTimingDimensions {
    const dimensions: Record<string, string> = {};
    for (const source of STORAGE_MANIFEST_SOURCES) {
      if (args.resolved) {
        dimensions[`storage_manifest_source_${source}_resolved_count_bucket`] =
          storageManifestCountBucket(args.resolved[source]);
      }
      if (args.plannedPresign) {
        dimensions[
          `storage_manifest_source_${source}_planned_presign_count_bucket`
        ] = storageManifestCountBucket(args.plannedPresign[source]);
      }
      if (args.nonSystemPresign) {
        dimensions[
          `storage_manifest_source_${source}_non_system_presign_count_bucket`
        ] = storageManifestCountBucket(args.nonSystemPresign[source]);
      }
    }
    return dimensions;
  }

  private systemPresignCacheDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_system_resolved_storage_count_bucket:
        storageManifestCountBucket(this.systemResolvedStorageCount),
      storage_manifest_system_presign_cache_hit_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheHitCount),
      storage_manifest_system_presign_cache_miss_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheMissCount),
      storage_manifest_non_system_presign_count_bucket:
        storageManifestCountBucket(this.nonSystemPresignCount),
    };
  }

  private workflowSkillPresignCacheDimensions(): ApiDispatchTimingDimensions {
    return {
      storage_manifest_workflow_skill_presign_cache_hit_count_bucket:
        storageManifestCountBucket(this.workflowSkillPresignCacheHitCount),
      storage_manifest_workflow_skill_presign_cache_miss_count_bucket:
        storageManifestCountBucket(this.workflowSkillPresignCacheMissCount),
    };
  }
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
    runContextArtifact: {
      mountPath: artifact.mountPath,
      vasStorageName: artifact.name,
      vasVersionId: resolved.versionId,
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

function mergeStorageEntries<TEntry>(args: {
  readonly composeEntries: readonly TEntry[];
  readonly additionalEntries: readonly TEntry[];
  readonly mountPath: (entry: TEntry) => string;
}): readonly TEntry[] {
  const additionalMountPaths = new Set(
    args.additionalEntries.map((entry) => {
      return args.mountPath(entry);
    }),
  );
  return [
    ...args.composeEntries.filter((entry) => {
      return !additionalMountPaths.has(args.mountPath(entry));
    }),
    ...args.additionalEntries,
  ];
}

export async function finalizePreparedStorage<
  TMount extends StorageMountMetadata,
>(args: {
  readonly entries: PreparedStorageEntries<TMount>;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Promise<PreparedAgentRunStorage<TMount>> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_assemble",
    "nested",
    () => {
      const readOnlyEntries = mergeStorageEntries({
        composeEntries: args.entries.composeEntries,
        additionalEntries: args.entries.additionalEntries,
        mountPath(entry) {
          return entry.storedMount.mountPath;
        },
      });
      args.stats?.recordFinalStorage({
        composeEntryCount: args.entries.composeEntries.length,
        additionalEntryCount: args.entries.additionalEntries.length,
        finalReadOnlyEntryCount: readOnlyEntries.length,
        finalWritebackEntryCount: args.entries.writebackEntries.length,
        resolvedComposeEntryCount: args.entries.resolvedComposeEntryCount,
        resolvedAdditionalEntryCount: args.entries.resolvedAdditionalEntryCount,
      });
      const writebackEntry = args.entries.writebackEntries[0];
      return {
        runContextStorage: {
          volumes: readOnlyEntries.map((entry) => {
            return entry.runContextVolume;
          }),
          artifact: writebackEntry?.runContextArtifact ?? null,
        },
        storageMounts: normalizeMountOverlay([
          ...readOnlyEntries.map((entry) => {
            return entry.storedMount;
          }),
          ...args.entries.writebackEntries.map((entry) => {
            return entry.storedMount;
          }),
        ]),
        persistedStorageMounts: normalizeMountOverlay([
          ...readOnlyEntries.map((entry) => {
            return entry.persistedMount;
          }),
          ...args.entries.writebackEntries.map((entry) => {
            return entry.persistedMount;
          }),
        ]),
      };
    },
    () => {
      return args.stats?.assembleDimensions();
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
    ...(prepared.instructionsTargetFilename === undefined
      ? {}
      : { instructionsTargetFilename: prepared.instructionsTargetFilename }),
  };
}
