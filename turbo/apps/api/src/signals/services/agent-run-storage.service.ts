import {
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CODEX_HOME_DIR,
  PI_AGENT_DIR,
  type StoredStorageMountEntry,
} from "@okouai/api-contracts/contracts/runners";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { expandVariablesInString } from "@okouai/core/variable-expander";
import {
  getInstructionsFilename,
  type SupportedFramework,
} from "@okouai/core/frameworks";
import {
  getInstructionsStorageName,
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
} from "@okouai/core/storage-names";
import {
  isValidVersionPrefix,
  MIN_VERSION_PREFIX_LENGTH,
  VERSION_ID_LENGTH,
} from "@okouai/core/version-id";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import type { PersistedStorageMount } from "@okouai/db/types";
import { computed, type Computed } from "ccstate";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { env } from "../../lib/env";
import type { Db } from "../external/db";
import { now, nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  readOnlyStoragePresignedUrlCacheKey,
  resolveReadOnlyStoragePresignedUrls,
  resolveWorkflowSkillStoragePresignedUrls,
  resolveSystemStoragePresignedUrls,
  SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  systemStoragePresignedUrlCacheKey,
  WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
  workflowSkillStoragePresignedUrlCacheKey,
  type SystemStoragePresignedUrlCacheStatus,
  type SystemStoragePresignedUrlRequest,
  type ReadOnlyStoragePresignedUrlCacheStatus,
  type ReadOnlyStoragePresignedUrlRequest,
  type StoragePresignedUrlResult,
  type WorkflowSkillStoragePresignedUrlCacheStatus,
  type WorkflowSkillStoragePresignedUrlRequest,
} from "./system-storage-presigned-url-cache.service";
import {
  measureApiDispatchTiming,
  type ApiDispatchTimingCollector,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
  type ApiDispatchTimingDimensionsInput,
} from "./api-dispatch-timing.service";
import { computeContentHashFromHashes } from "./storage-content-hash.service";
import { enqueueMemorySummaryProjection } from "./memory-summary-projection.service";
import { newStorageS3Location } from "./storage-s3-prefix.utils";

import { publishPiResourceVersionIndex } from "./pi-resource-version-index.service";

type StorageManifestEntryKind = "compose" | "additional" | "artifact";
export type StorageManifestSource =
  | "system_skill"
  | "connector_skill"
  | "custom_connector_skill"
  | "official_workflow"
  | "workflow_skill"
  | "request_additional_volume"
  | "compose_additional_volume"
  | "compose_volume"
  | "artifact"
  | "unknown";
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

interface AdditionalVolume {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly system?: boolean;
  readonly baselineCandidate?: true;
  readonly expectedStorageId?: string;
}

interface VolumeConfig {
  readonly name: string;
  readonly version: string;
  readonly optional?: boolean;
  readonly system?: boolean;
}

interface AgentConfig {
  readonly framework?: string;
  readonly volumes?: readonly string[];
  readonly instructions?: unknown;
}

interface AgentExecutionConfig {
  readonly agent?: AgentConfig;
  readonly agents?: Record<string, AgentConfig | undefined>;
  readonly volumes?: Record<string, VolumeConfig | undefined>;
}

interface PrepareAgentRunStorageManifestArgs {
  readonly db: Db;
  readonly content: AgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
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

interface StorageLookup {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface StorageRequest {
  readonly lookup: StorageLookup;
  readonly version: string | undefined;
}

interface StorageIndexRequest {
  readonly lookup: StorageLookup;
  readonly exactVersionId: string | null;
}

interface StorageIndexRow {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly headId: string | null;
  readonly headS3Key: string | null;
  readonly headArchiveSize: number | null;
  readonly headFileCount: number | null;
  readonly exactId: string | null;
  readonly exactS3Key: string | null;
  readonly exactArchiveSize: number | null;
  readonly exactFileCount: number | null;
}

interface ArtifactStorageRow {
  readonly id: string;
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
}

interface StorageVersionIndexEntry {
  readonly id: string;
  readonly s3Key: string;
  readonly archiveSize: number;
  readonly fileCount: number;
}

interface StorageIndexEntry {
  readonly storageId: string;
  readonly headVersionId: string | null;
  readonly s3Prefix: string;
  readonly headVersion: StorageVersionIndexEntry | null;
  readonly exactVersions: ReadonlyMap<string, StorageVersionIndexEntry>;
}

interface StorageManifestInputs {
  readonly artifacts: readonly ContextArtifact[];
  readonly composeVolumes: readonly ResolvedVolume[];
}

interface PreparedReadOnlyStorageEntry {
  readonly storedMount: StoredStorageMountEntry;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextVolume: RunContextResponse["volumes"][number];
}

interface PreparedWritebackStorageEntry {
  readonly storedMount: StoredStorageMountEntry;
  readonly persistedMount: PersistedStorageMount;
  readonly runContextArtifact: NonNullable<RunContextResponse["artifact"]>;
}

interface PreparedStorageEntries {
  readonly composeEntries: readonly PreparedReadOnlyStorageEntry[];
  readonly additionalEntries: readonly PreparedReadOnlyStorageEntry[];
  readonly writebackEntries: readonly PreparedWritebackStorageEntry[];
  readonly resolvedComposeEntryCount: number;
  readonly resolvedAdditionalEntryCount: number;
}

interface RunContextStorageObservation {
  readonly volumes: RunContextResponse["volumes"];
  readonly artifact: RunContextResponse["artifact"];
}

export interface PreparedAgentRunStorage {
  readonly storageMounts: readonly StoredStorageMountEntry[];
  readonly persistedStorageMounts: readonly PersistedStorageMount[];
  readonly runContextStorage: RunContextStorageObservation;
}

interface BuildStorageManifestEntriesArgs {
  readonly db: Db;
  readonly bucket: string;
  readonly storageIndex: StorageIndex;
  readonly agentOrgId: string;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly composeVolumes: readonly ResolvedVolume[];
  readonly additionalVolumes: readonly AdditionalVolume[] | undefined;
  readonly additionalVolumeSources:
    | readonly StorageManifestSource[]
    | undefined;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}

interface StorageManifestEntryPhaseTimings {
  readonly compose: StorageManifestEntryPhaseTiming;
  readonly additional: StorageManifestEntryPhaseTiming;
  readonly artifact: StorageManifestEntryPhaseTiming;
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
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
  readonly optional?: boolean;
  readonly resolved: StorageResolution;
}

interface ResolvedManifestArtifactInput {
  readonly artifact: ContextArtifact;
  readonly resolved: StorageResolution;
  readonly source: StorageManifestSource;
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

/**
 * Pre-fetched (orgId, userId, name) -> storage row and requested exact-version
 * map. A single run resolves dozens to hundreds of volumes/artifacts; looking
 * each one up with its own database round-trip saturates the connection pool,
 * so the exact requested rows and full pinned versions are loaded once and
 * resolved from memory instead.
 */
type StorageIndex = ReadonlyMap<string, StorageIndexEntry>;

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
const STORAGE_MANIFEST_ARTIFACT_ENSURE_ACTION_TYPES = [
  "api_dispatch_prepare_storage_manifest_ensure_artifact_lookup_storage",
  "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_storage",
  "api_dispatch_prepare_storage_manifest_ensure_artifact_refetch_storage",
  "api_dispatch_prepare_storage_manifest_ensure_artifact_skip_initialized",
  "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_initial_version",
] as const satisfies readonly ApiDispatchTimingActionType[];

type StorageManifestArtifactEnsureActionType =
  (typeof STORAGE_MANIFEST_ARTIFACT_ENSURE_ACTION_TYPES)[number];
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
  private systemPresignCacheStaleReuseCount = 0;
  private systemPresignCacheSyncRefreshCount = 0;
  private workflowSkillPresignCacheHitCount = 0;
  private workflowSkillPresignCacheMissCount = 0;
  private workflowSkillPresignCacheStaleReuseCount = 0;
  private workflowSkillPresignCacheSyncRefreshCount = 0;
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
      case "stale_reuse": {
        this.systemPresignCacheStaleReuseCount += 1;
        return;
      }
      case "sync_refresh": {
        this.systemPresignCacheSyncRefreshCount += 1;
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
      case "stale_reuse": {
        this.workflowSkillPresignCacheStaleReuseCount += 1;
        return;
      }
      case "sync_refresh": {
        this.workflowSkillPresignCacheSyncRefreshCount += 1;
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
      storage_manifest_system_presign_cache_stale_reuse_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheStaleReuseCount),
      storage_manifest_system_presign_cache_sync_refresh_count_bucket:
        storageManifestCountBucket(this.systemPresignCacheSyncRefreshCount),
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
      storage_manifest_workflow_skill_presign_cache_stale_reuse_count_bucket:
        storageManifestCountBucket(
          this.workflowSkillPresignCacheStaleReuseCount,
        ),
      storage_manifest_workflow_skill_presign_cache_sync_refresh_count_bucket:
        storageManifestCountBucket(
          this.workflowSkillPresignCacheSyncRefreshCount,
        ),
    };
  }
}

class StorageManifestArtifactEnsureTiming {
  private readonly windows = new Map<
    StorageManifestArtifactEnsureActionType,
    StorageManifestPhaseTimingWindow
  >();

  constructor(
    private readonly timing: ApiDispatchTimingCollector | undefined,
  ) {}

  async measure<T>(
    actionType: StorageManifestArtifactEnsureActionType,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.timing) {
      return await operation();
    }

    const window = this.windowFor(actionType);
    const startedAt = now();
    window.startedAt =
      window.startedAt === undefined
        ? startedAt
        : Math.min(window.startedAt, startedAt);
    return await operation().finally(() => {
      const finishedAt = now();
      window.finishedAt =
        window.finishedAt === undefined
          ? finishedAt
          : Math.max(window.finishedAt, finishedAt);
    });
  }

  flush(): void {
    if (!this.timing) {
      return;
    }

    for (const actionType of STORAGE_MANIFEST_ARTIFACT_ENSURE_ACTION_TYPES) {
      const window = this.windows.get(actionType);
      const finishedAt = window?.finishedAt ?? now();
      this.timing.recordElapsed(
        actionType,
        "nested",
        window?.startedAt ?? finishedAt,
        finishedAt,
      );
    }
  }

  private windowFor(
    actionType: StorageManifestArtifactEnsureActionType,
  ): StorageManifestPhaseTimingWindow {
    const existing = this.windows.get(actionType);
    if (existing) {
      return existing;
    }

    const created: StorageManifestPhaseTimingWindow = {
      startedAt: undefined,
      finishedAt: undefined,
    };
    this.windows.set(actionType, created);
    return created;
  }
}

async function measureStorageManifestArtifactEnsure<T>(
  timing: StorageManifestArtifactEnsureTiming | undefined,
  actionType: StorageManifestArtifactEnsureActionType,
  operation: () => Promise<T>,
): Promise<T> {
  return timing
    ? await timing.measure(actionType, operation)
    : await operation();
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
      | ApiDispatchTimingDimensionsInput
      | undefined,
    private readonly generateDimensions:
      | ApiDispatchTimingDimensionsInput
      | undefined,
  ) {}

  async measureResolve<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.resolveWindow, operation);
  }

  async measureGenerate<T>(operation: () => Promise<T>): Promise<T> {
    return await this.measure(this.generateWindow, operation);
  }

  flush(): void {
    this.record(
      this.resolveActionType,
      this.resolveWindow,
      this.resolveDimensions,
    );
    this.record(
      this.generateActionType,
      this.generateWindow,
      this.generateDimensions,
    );
  }

  private async measure<T>(
    window: StorageManifestPhaseTimingWindow,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.timing) {
      return await operation();
    }

    const startedAt = now();
    window.startedAt =
      window.startedAt === undefined
        ? startedAt
        : Math.min(window.startedAt, startedAt);
    return await operation().finally(() => {
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

function firstAgentEntry(
  content: AgentExecutionConfig,
): { readonly name: string | undefined; readonly agent: AgentConfig } | null {
  if (content.agent) {
    return { name: undefined, agent: content.agent };
  }

  const firstEntry = Object.entries(content.agents ?? {})[0];
  if (!firstEntry?.[1]) {
    return null;
  }
  return { name: firstEntry[0], agent: firstEntry[1] };
}

function parseVolumeDeclaration(declaration: string): {
  readonly name: string;
  readonly mountPath: string;
} {
  const [name, mountPath, extra] = declaration.split(":");
  if (extra !== undefined || !name?.trim() || !mountPath?.trim()) {
    throw new Error(
      `Invalid volume declaration: ${declaration}. Expected format: volume-name:/mount/path`,
    );
  }
  return { name: name.trim(), mountPath: mountPath.trim() };
}

function expandTemplate(
  value: string,
  vars: Record<string, string> | undefined,
  context: string,
): string {
  const { result, missingVars } = expandVariablesInString(value, {
    vars: vars ?? {},
  });
  if (missingVars.length > 0) {
    throw new Error(
      `${context} is missing required variables: ${missingVars
        .map((ref) => {
          return ref.name;
        })
        .join(", ")}`,
    );
  }
  return result;
}

function resolveComposeVolumes(args: {
  readonly content: AgentExecutionConfig;
  readonly vars: Record<string, string> | undefined;
  readonly volumeVersionOverrides: Record<string, string> | undefined;
  readonly framework: SupportedFramework | "pi";
}): readonly ResolvedVolume[] {
  const entry = firstAgentEntry(args.content);
  if (!entry) {
    return [];
  }

  const resolved: ResolvedVolume[] = [];
  for (const declaration of entry.agent.volumes ?? []) {
    const parsed = parseVolumeDeclaration(declaration);
    const config = args.content.volumes?.[parsed.name];
    if (!config) {
      throw new Error(
        `Volume "${parsed.name}" is not defined in the volumes section`,
      );
    }

    const versionOverride = args.volumeVersionOverrides?.[parsed.name];
    resolved.push({
      name: parsed.name,
      mountPath: parsed.mountPath,
      vasStorageName: expandTemplate(
        config.name,
        args.vars,
        `Volume "${parsed.name}" name`,
      ),
      vasVersion: expandTemplate(
        versionOverride ?? config.version,
        args.vars,
        `Volume "${parsed.name}" version`,
      ),
      optional: config.optional,
      system: config.system,
    });
  }

  if (entry.agent.instructions && entry.name) {
    const storageName = getInstructionsStorageName(entry.name);
    resolved.push({
      name: storageName,
      mountPath: instructionsMountPath(args.framework),
      vasStorageName: storageName,
      vasVersion: "latest",
      instructionsTargetFilename: instructionsFilename(args.framework),
    });
  }

  return resolved;
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

async function findStorage(
  db: Db,
  lookup: StorageLookup,
): Promise<ArtifactStorageRow | undefined> {
  const [storage] = await db
    .select({
      id: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
    })
    .from(storages)
    .where(
      and(
        eq(storages.orgId, lookup.orgId),
        eq(storages.userId, lookup.userId),
        eq(storages.name, lookup.name),
      ),
    )
    .limit(1);
  return storage;
}

function storageIndexKey(orgId: string, userId: string, name: string): string {
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

const headStorageVersions = alias(storageVersions, "head_storage_versions");
const exactStorageVersions = alias(storageVersions, "exact_storage_versions");

function uniqueStorageIndexRequests(
  requests: readonly StorageRequest[],
): readonly StorageIndexRequest[] {
  const requestsByKey = new Map<string, StorageIndexRequest>();
  for (const request of requests) {
    const exactVersionId =
      request.version !== undefined && isFullStorageVersionId(request.version)
        ? request.version
        : null;
    requestsByKey.set(
      JSON.stringify([
        request.lookup.orgId,
        request.lookup.userId,
        request.lookup.name,
        exactVersionId,
      ]),
      { lookup: request.lookup, exactVersionId },
    );
  }
  return [...requestsByKey.values()];
}

function buildStorageIndex(rows: readonly StorageIndexRow[]): StorageIndex {
  const exactVersionsByStorageId = new Map<
    string,
    Map<string, StorageVersionIndexEntry>
  >();
  for (const row of rows) {
    if (
      row.exactId === null ||
      row.exactS3Key === null ||
      row.exactArchiveSize === null ||
      row.exactFileCount === null
    ) {
      continue;
    }
    const versions =
      exactVersionsByStorageId.get(row.storageId) ??
      new Map<string, StorageVersionIndexEntry>();
    versions.set(row.exactId, {
      id: row.exactId,
      s3Key: row.exactS3Key,
      archiveSize: row.exactArchiveSize,
      fileCount: row.exactFileCount,
    });
    exactVersionsByStorageId.set(row.storageId, versions);
  }

  const index = new Map<string, StorageIndexEntry>();
  for (const row of rows) {
    const key = storageIndexKey(row.orgId, row.userId, row.name);
    if (index.has(key)) {
      continue;
    }
    index.set(key, {
      storageId: row.storageId,
      headVersionId: row.headVersionId,
      s3Prefix: row.s3Prefix,
      headVersion:
        row.headId &&
        row.headS3Key &&
        row.headArchiveSize !== null &&
        row.headFileCount !== null
          ? {
              id: row.headId,
              s3Key: row.headS3Key,
              archiveSize: row.headArchiveSize,
              fileCount: row.headFileCount,
            }
          : null,
      exactVersions:
        exactVersionsByStorageId.get(row.storageId) ??
        new Map<string, StorageVersionIndexEntry>(),
    });
  }
  return index;
}

async function loadStorageIndex(
  db: Db,
  requests: readonly StorageRequest[],
): Promise<StorageIndex> {
  const uniqueRequests = uniqueStorageIndexRequests(requests);
  if (uniqueRequests.length === 0) {
    return new Map<string, StorageIndexEntry>();
  }

  const orgIds = uniqueRequests.map((request) => {
    return request.lookup.orgId;
  });
  const userIds = uniqueRequests.map((request) => {
    return request.lookup.userId;
  });
  const names = uniqueRequests.map((request) => {
    return request.lookup.name;
  });
  const exactVersionIds = uniqueRequests.map((request) => {
    return request.exactVersionId;
  });
  // Raw array interpolation expands to a SQL tuple in Drizzle. Keep each
  // zipped array in one driver parameter so the statement shape stays fixed.
  const rows: StorageIndexRow[] = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      name: storages.name,
      storageId: storages.id,
      headVersionId: storages.headVersionId,
      s3Prefix: storages.s3Prefix,
      headId: headStorageVersions.id,
      headS3Key: headStorageVersions.s3Key,
      headArchiveSize: headStorageVersions.archiveSize,
      headFileCount: headStorageVersions.fileCount,
      exactId: exactStorageVersions.id,
      exactS3Key: exactStorageVersions.s3Key,
      exactArchiveSize: exactStorageVersions.archiveSize,
      exactFileCount: exactStorageVersions.fileCount,
    })
    .from(storages)
    .innerJoin(
      sql`unnest(
        ${sql.param(orgIds)}::text[],
        ${sql.param(userIds)}::text[],
        ${sql.param(names)}::varchar(256)[],
        ${sql.param(exactVersionIds)}::varchar(64)[]
      ) AS requested(org_id, user_id, name, version_id)`,
      and(
        eq(storages.orgId, sql`requested.org_id`),
        eq(storages.userId, sql`requested.user_id`),
        eq(storages.name, sql`requested.name`),
      ),
    )
    .leftJoin(
      headStorageVersions,
      eq(storages.headVersionId, headStorageVersions.id),
    )
    .leftJoin(
      exactStorageVersions,
      and(
        eq(
          exactStorageVersions.id,
          sql`NULLIF(requested.version_id, ${storages.headVersionId})`,
        ),
        eq(exactStorageVersions.storageId, storages.id),
      ),
    );

  return buildStorageIndex(rows);
}

interface EnsureArtifactStorageArgs {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly timing?: StorageManifestArtifactEnsureTiming;
  readonly stats?: StorageManifestBuildStats;
}

async function findOrCreateArtifactStorage(
  args: EnsureArtifactStorageArgs,
  lookup: StorageLookup,
): Promise<ArtifactStorageRow | undefined> {
  const storage = await measureStorageManifestArtifactEnsure(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifact_lookup_storage",
    async () => {
      return await findStorage(args.db, lookup);
    },
  );
  if (storage) {
    return storage;
  }

  args.stats?.recordArtifactEnsureMissingStorage();
  const [created] = await measureStorageManifestArtifactEnsure(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_storage",
    async () => {
      const location = newStorageS3Location(args.orgId);
      return await args.db
        .insert(storages)
        .values({
          id: location.storageId,
          orgId: args.orgId,
          userId: args.userId,
          name: args.name,
          s3Prefix: location.s3Prefix,
        })
        .onConflictDoNothing()
        .returning({
          id: storages.id,
          headVersionId: storages.headVersionId,
          s3Prefix: storages.s3Prefix,
        });
    },
  );
  if (created) {
    args.stats?.recordArtifactEnsureCreatedStorage();
    return created;
  }

  const refetched = await measureStorageManifestArtifactEnsure(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifact_refetch_storage",
    async () => {
      return await findStorage(args.db, lookup);
    },
  );
  if (refetched) {
    args.stats?.recordArtifactEnsureLostCreateRace();
  }
  return refetched;
}

async function recordInitializedArtifactFastPath(
  args: EnsureArtifactStorageArgs,
): Promise<void> {
  args.stats?.recordArtifactEnsureAlreadyInitialized();
  await measureStorageManifestArtifactEnsure(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifact_skip_initialized",
    async () => {},
  );
}

async function insertInitialArtifactVersion(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly storage: ArtifactStorageRow;
  readonly versionId: string;
  readonly s3Key: string;
  readonly timing?: StorageManifestArtifactEnsureTiming;
}): Promise<boolean> {
  return await measureStorageManifestArtifactEnsure(
    args.timing,
    "api_dispatch_prepare_storage_manifest_ensure_artifact_insert_initial_version",
    async () => {
      return await args.db.transaction(async (tx) => {
        await tx
          .insert(storageVersions)
          .values({
            id: args.versionId,
            storageId: args.storage.id,
            s3Key: args.s3Key,
            size: 0,
            archiveSize: 0,
            fileCount: 0,
            message: "Initial empty artifact",
            createdBy: args.userId,
          })
          .onConflictDoNothing();
        const [updated] = await tx
          .update(storages)
          .set({
            headVersionId: args.versionId,
            size: 0,
            fileCount: 0,
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(storages.id, args.storage.id),
              isNull(storages.headVersionId),
            ),
          )
          .returning({ id: storages.id });
        await publishPiResourceVersionIndex({
          db: tx,
          versionId: args.versionId,
          projection: { schemaVersion: 1, files: [] },
          archiveSize: 0,
        });
        if (updated) {
          await enqueueMemorySummaryProjection({
            db: tx,
            storage: {
              id: args.storage.id,
              orgId: args.orgId,
              userId: args.userId,
              name: args.name,
            },
            storageVersionId: args.versionId,
          });
        }
        return updated !== undefined;
      });
    },
  );
}

async function initializeEmptyArtifactStorage(
  args: EnsureArtifactStorageArgs,
  storage: ArtifactStorageRow,
): Promise<void> {
  args.stats?.recordArtifactEnsureMissingHeadVersion();
  const versionId = computeContentHashFromHashes(storage.id, []);
  const s3Key = `${storage.s3Prefix}/${versionId}`;
  const initializedHead = await insertInitialArtifactVersion({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    name: args.name,
    storage,
    versionId,
    s3Key,
    timing: args.timing,
  });
  if (initializedHead) {
    args.stats?.recordArtifactEnsureInitializedEmptyVersion();
  }
}

function ensureArtifactStorage(
  args: EnsureArtifactStorageArgs,
): Computed<Promise<void>> {
  return computed(async (): Promise<void> => {
    const lookup = artifactStorageLookup(args.orgId, args.userId, args.name);
    const storage = await findOrCreateArtifactStorage(args, lookup);
    if (!storage) {
      throw new Error(`Failed to create artifact storage "${args.name}"`);
    }
    if (storage.headVersionId) {
      await recordInitializedArtifactFastPath(args);
      return;
    }

    await initializeEmptyArtifactStorage(args, storage);
  });
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

async function queryExactVersion(
  db: Db,
  storage: StorageIndexEntry,
  lookup: StorageLookup,
  version: string,
): Promise<StorageResolution | null> {
  const [match] = await db
    .select({
      id: storageVersions.id,
      s3Prefix: storages.s3Prefix,
      s3Key: storageVersions.s3Key,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storageVersions)
    .innerJoin(storages, eq(storageVersions.storageId, storages.id))
    .where(
      and(
        eq(storageVersions.storageId, storage.storageId),
        eq(storageVersions.id, version),
        eq(storages.orgId, lookup.orgId),
        eq(storages.userId, lookup.userId),
        eq(storages.name, lookup.name),
      ),
    )
    .limit(1);
  return match
    ? {
        storageId: storage.storageId,
        versionId: match.id,
        s3Prefix: match.s3Prefix,
        s3Key: match.s3Key,
        archiveSize: match.archiveSize,
        fileCount: match.fileCount,
        resolvedOrgId: lookup.orgId,
        resolvedUserId: lookup.userId,
      }
    : null;
}

async function resolvePinnedVersion(
  db: Db,
  index: StorageIndex,
  lookup: StorageLookup,
  version: string,
): Promise<StorageResolution> {
  const storage = index.get(
    storageIndexKey(lookup.orgId, lookup.userId, lookup.name),
  );
  if (!storage) {
    throw new Error(`Storage "${lookup.name}" not found in database`);
  }

  if (isFullStorageVersionId(version)) {
    const exactMatch = resolvePreloadedExactVersion(storage, lookup, version);
    if (exactMatch) {
      return exactMatch;
    }
    throw new Error(`Storage "${lookup.name}" version "${version}" not found`);
  }

  const exactMatch = await queryExactVersion(db, storage, lookup, version);
  if (exactMatch) {
    return exactMatch;
  }

  if (!isValidVersionPrefix(version)) {
    throw new Error(
      `Version prefix too short. Minimum ${MIN_VERSION_PREFIX_LENGTH} characters required.`,
    );
  }

  const matches = await db
    .select({
      id: storageVersions.id,
      s3Key: storageVersions.s3Key,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storageVersions)
    .where(
      and(
        eq(storageVersions.storageId, storage.storageId),
        like(storageVersions.id, `${version}%`),
      ),
    )
    .limit(2);
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
  return {
    storageId: storage.storageId,
    versionId: match.id,
    s3Prefix: storage.s3Prefix,
    s3Key: match.s3Key,
    archiveSize: match.archiveSize,
    fileCount: match.fileCount,
    resolvedOrgId: lookup.orgId,
    resolvedUserId: lookup.userId,
  };
}

async function resolveStorageVersion(
  db: Db,
  index: StorageIndex,
  lookup: StorageLookup,
  version: string | undefined,
): Promise<StorageResolution> {
  return version === undefined || version === "latest"
    ? resolveLatestVersion(index, lookup)
    : await resolvePinnedVersion(db, index, lookup, version);
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

async function resolveVolumeStorage(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly volume: ResolvedVolume | AdditionalVolume;
  readonly primaryOrgId: string;
  readonly allowSystemFallback: boolean;
}): Promise<StorageResolution | null> {
  if (args.allowSystemFallback && args.volume.system) {
    const systemResult = await settle(
      resolveStorageVersion(
        args.db,
        args.index,
        volumeStorageLookup(SYSTEM_ORG_ID, args.volume),
        volumeVersion(args.volume),
      ),
    );
    if (systemResult.ok) {
      return systemResult.value;
    }
    if (!isMissingStorageError(systemResult.error)) {
      throw systemResult.error;
    }
  }

  return await resolveStorageVersion(
    args.db,
    args.index,
    volumeStorageLookup(args.primaryOrgId, args.volume),
    volumeVersion(args.volume),
  );
}

async function resolveComposeStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly agentOrgId: string;
  readonly volume: ResolvedVolume;
}): Promise<ResolvedManifestStorageInput | null> {
  const resolvedResult = await settle(
    resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.agentOrgId,
      allowSystemFallback: true,
    }),
  );
  if (!resolvedResult.ok) {
    if (args.volume.optional && isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.value) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.vasStorageName,
    instructionsTargetFilename: args.volume.instructionsTargetFilename,
    optional: args.volume.optional,
    resolved: resolvedResult.value,
  };
}

async function resolveAdditionalStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly volume: AdditionalVolume;
  readonly source: StorageManifestSource;
}): Promise<ResolvedManifestStorageInput | null> {
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
  const resolvedResult = await settle(
    resolveVolumeStorage({
      db: args.db,
      index: args.index,
      volume: args.volume,
      primaryOrgId: args.runtimeOrgId,
      allowSystemFallback: true,
    }),
  );
  if (!resolvedResult.ok) {
    if (isMissingStorageError(resolvedResult.error)) {
      return null;
    }
    throw resolvedResult.error;
  }
  if (!resolvedResult.value) {
    return null;
  }
  return {
    name: args.volume.name,
    mountPath: args.volume.mountPath,
    vasStorageName: args.volume.name,
    ...(args.volume.baselineCandidate === true
      ? { baselineCandidate: args.volume.baselineCandidate }
      : {}),
    resolved: resolvedResult.value,
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

async function resolveArtifactStorageInput(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifact: ContextArtifact;
  readonly source: StorageManifestSource;
}): Promise<ResolvedManifestArtifactInput> {
  const resolved = await resolveStorageVersion(
    args.db,
    args.index,
    artifactStorageLookup(args.runtimeOrgId, args.userId, args.artifact.name),
    args.artifact.version,
  );
  return { artifact: args.artifact, resolved, source: args.source };
}

function storageArchiveKey(resolved: StorageResolution): string {
  return `${resolved.s3Key}/archive.tar.gz`;
}

function knownArchiveSize(resolved: StorageResolution): number | undefined {
  return Number.isSafeInteger(resolved.archiveSize) && resolved.archiveSize > 0
    ? resolved.archiveSize
    : undefined;
}

function isSystemOwnedStoragePlan(plan: ResolvedManifestStoragePlan): boolean {
  return plan.resolved.resolvedOrgId === SYSTEM_ORG_ID;
}

function isWorkflowSkillStoragePlan(
  plan: ResolvedManifestStoragePlan,
): boolean {
  return plan.source === "workflow_skill";
}

function systemStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
}): SystemStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.plan.resolved),
    storageVersionId: args.plan.resolved.versionId,
    publicEndpoint: true,
  };
}

function workflowSkillStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
}): WorkflowSkillStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.plan.resolved),
    storageVersionId: args.plan.resolved.versionId,
    resolvedOrgId: args.plan.resolved.resolvedOrgId,
    publicEndpoint: true,
  };
}

function readOnlyStoragePresignedUrlRequest(args: {
  readonly bucket: string;
  readonly resolved: StorageResolution;
}): ReadOnlyStoragePresignedUrlRequest {
  return {
    bucket: args.bucket,
    objectKey: storageArchiveKey(args.resolved),
    storageVersionId: args.resolved.versionId,
    resolvedOrgId: args.resolved.resolvedOrgId,
    publicEndpoint: true,
  };
}

function buildPreparedReadOnlyStorageEntry(args: {
  readonly plan: ResolvedManifestStoragePlan;
  readonly archiveUrl: string;
}): PreparedReadOnlyStorageEntry {
  const archiveSize = knownArchiveSize(args.plan.resolved);
  return {
    storedMount: {
      orgId: args.plan.resolved.resolvedOrgId,
      userId: args.plan.resolved.resolvedUserId,
      name: args.plan.vasStorageName,
      storageId: args.plan.resolved.storageId,
      versionId: args.plan.resolved.versionId,
      mountPath: args.plan.mountPath,
      archiveUrl: args.archiveUrl,
      ...(archiveSize === undefined ? {} : { archiveSize }),
      ...(args.plan.baselineCandidate === true
        ? { baselineCandidate: args.plan.baselineCandidate }
        : {}),
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

function normalizeMountOverlay<T extends { readonly mountPath: string }>(
  mounts: readonly T[],
): readonly T[] {
  const byMountPath = new Map<string, T>();
  for (const mount of mounts) {
    // Mount application is last-wins. Delete first so the canonical list also
    // preserves the winning entry's relative order.
    byMountPath.delete(mount.mountPath);
    byMountPath.set(mount.mountPath, mount);
  }
  return [...byMountPath.values()];
}

function buildWorkflowSkillStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = workflowSkillStoragePresignedUrlRequest({
    bucket: args.bucket,
    plan: args.plan,
  });
  const result = args.urlsByCacheKey.get(
    workflowSkillStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error(
      "Missing workflow skill storage presigned URL cache result",
    );
  }
  args.stats?.recordWorkflowSkillPresignCacheResult(result.status);
  if (result.status === "miss" || result.status === "sync_refresh") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: WORKFLOW_SKILL_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign(args.plan.entryKind, args.plan.source);
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

function buildReadOnlyStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = readOnlyStoragePresignedUrlRequest({
    bucket: args.bucket,
    resolved: args.plan.resolved,
  });
  const result = args.urlsByCacheKey.get(
    readOnlyStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error("Missing readonly storage presigned URL cache result");
  }
  if (result.status === "miss" || result.status === "sync_refresh") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign(args.plan.entryKind, args.plan.source);
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

function buildSystemStorageEntry(args: {
  readonly bucket: string;
  readonly plan: ResolvedManifestStoragePlan;
  readonly urlsByCacheKey: ReadonlyMap<string, StoragePresignedUrlResult>;
  readonly stats?: StorageManifestBuildStats;
}): PreparedReadOnlyStorageEntry {
  const request = systemStoragePresignedUrlRequest({
    bucket: args.bucket,
    plan: args.plan,
  });
  const result = args.urlsByCacheKey.get(
    systemStoragePresignedUrlCacheKey(request),
  );
  if (!result) {
    throw new Error("Missing system storage presigned URL cache result");
  }
  args.stats?.recordSystemPresignCacheResult(result.status);
  if (result.status === "miss" || result.status === "sync_refresh") {
    args.stats?.recordPresignCandidate(args.plan.entryKind, args.plan.source, {
      bucket: args.bucket,
      key: storageArchiveKey(args.plan.resolved),
      expiresIn: SYSTEM_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
  }
  return buildPreparedReadOnlyStorageEntry({
    plan: args.plan,
    archiveUrl: result.url,
  });
}

function buildStorageEntriesFromPlans(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly plans: readonly ResolvedManifestStoragePlan[];
  readonly stats?: StorageManifestBuildStats;
}): Computed<Promise<readonly PreparedReadOnlyStorageEntry[]>> {
  return computed(async (get) => {
    const systemPlans = args.plans.filter(isSystemOwnedStoragePlan);
    args.stats?.recordSystemResolvedStorage(systemPlans.length);

    const systemUrlsByCacheKeyPromise = get(
      resolveSystemStoragePresignedUrls({
        db: args.db,
        requests: systemPlans.map((plan) => {
          return systemStoragePresignedUrlRequest({
            bucket: args.bucket,
            plan,
          });
        }),
      }),
    );
    const workflowSkillUrlsByCacheKeyPromise = get(
      resolveWorkflowSkillStoragePresignedUrls({
        db: args.db,
        requests: args.plans
          .filter((plan) => {
            return (
              !isSystemOwnedStoragePlan(plan) &&
              isWorkflowSkillStoragePlan(plan)
            );
          })
          .map((plan) => {
            return workflowSkillStoragePresignedUrlRequest({
              bucket: args.bucket,
              plan,
            });
          }),
      }),
    );
    const readOnlyUrlsByCacheKeyPromise = get(
      resolveReadOnlyStoragePresignedUrls({
        db: args.db,
        requests: args.plans
          .filter((plan) => {
            return (
              !isSystemOwnedStoragePlan(plan) &&
              !isWorkflowSkillStoragePlan(plan)
            );
          })
          .map((plan) => {
            return readOnlyStoragePresignedUrlRequest({
              bucket: args.bucket,
              resolved: plan.resolved,
            });
          }),
      }),
    );

    return await Promise.all(
      args.plans.map(async (plan) => {
        if (isSystemOwnedStoragePlan(plan)) {
          return buildSystemStorageEntry({
            bucket: args.bucket,
            plan,
            urlsByCacheKey: await systemUrlsByCacheKeyPromise,
            stats: args.stats,
          });
        }
        if (isWorkflowSkillStoragePlan(plan)) {
          return buildWorkflowSkillStorageEntry({
            bucket: args.bucket,
            plan,
            urlsByCacheKey: await workflowSkillUrlsByCacheKeyPromise,
            stats: args.stats,
          });
        }
        return buildReadOnlyStorageEntry({
          bucket: args.bucket,
          plan,
          urlsByCacheKey: await readOnlyUrlsByCacheKeyPromise,
          stats: args.stats,
        });
      }),
    );
  });
}

function buildPreparedWritebackStorageEntry(args: {
  readonly bucket: string;
  readonly input: ResolvedManifestArtifactInput;
  readonly archiveUrl: string | undefined;
  readonly cacheStatus: ReadOnlyStoragePresignedUrlCacheStatus | undefined;
  readonly stats?: StorageManifestBuildStats;
}): PreparedWritebackStorageEntry {
  const { artifact, resolved } = args.input;
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

  const archiveKey = `${resolved.s3Key}/archive.tar.gz`;
  if (args.archiveUrl === undefined || args.cacheStatus === undefined) {
    throw new Error("Missing writeback storage presigned URL cache result");
  }
  if (args.cacheStatus === "miss" || args.cacheStatus === "sync_refresh") {
    args.stats?.recordPresignCandidate("artifact", args.input.source, {
      bucket: args.bucket,
      key: archiveKey,
      expiresIn: READ_ONLY_STORAGE_PRESIGNED_URL_TTL_SECONDS,
      filename: undefined,
      usePublicEndpoint: true,
    });
    args.stats?.recordNonSystemPresign("artifact", args.input.source);
  }
  const archiveSize = knownArchiveSize(resolved);

  return {
    ...preparedBase,
    storedMount: {
      ...storedMountBase,
      archiveUrl: args.archiveUrl,
      ...(archiveSize === undefined ? {} : { archiveSize }),
    },
  };
}

async function buildComposeStorageEntry(args: {
  readonly db: Db;
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
  readonly db: Db;
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

async function resolveStorageManifestInputs(
  args: PrepareAgentRunStorageManifestArgs,
): Promise<StorageManifestInputs> {
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_resolve_inputs",
    "nested",
    () => {
      return {
        artifacts: dedupArtifacts(args.artifacts),
        composeVolumes: resolveComposeVolumes({
          content: args.content,
          vars: args.vars,
          volumeVersionOverrides: args.volumeVersionOverrides,
          framework: args.framework,
        }),
      };
    },
  );
}

function ensureStorageManifestArtifacts(args: {
  readonly db: Db;
  readonly runtimeOrgId: string;
  readonly userId: string;
  readonly artifacts: readonly ContextArtifact[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Computed<Promise<void>> {
  return computed(async (get) => {
    const artifactEnsureTiming = new StorageManifestArtifactEnsureTiming(
      args.timing,
    );
    await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_ensure_artifacts",
      "nested",
      async () => {
        await Promise.all(
          args.artifacts.map((artifact) => {
            return get(
              ensureArtifactStorage({
                db: args.db,
                orgId: args.runtimeOrgId,
                userId: args.userId,
                name: artifact.name,
                timing: artifactEnsureTiming,
                stats: args.stats,
              }),
            );
          }),
        ).finally(() => {
          artifactEnsureTiming.flush();
        });
      },
      () => {
        return args.stats?.artifactEnsureDimensions();
      },
    );
  });
}

async function loadTimedStorageIndex(args: {
  readonly db: Db;
  readonly requests: readonly StorageRequest[];
  readonly timing?: ApiDispatchTimingCollector;
}): Promise<StorageIndex> {
  // Resolve every volume/artifact and full pinned version from one pre-fetched
  // snapshot instead of per-item database round-trips. Loaded after
  // ensureArtifactStorage so freshly created artifact rows are included.
  return await measureApiDispatchTiming(
    args.timing,
    "api_dispatch_prepare_storage_manifest_load_storage_index",
    "nested",
    async () => {
      return await loadStorageIndex(args.db, args.requests);
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
    | readonly StorageManifestSource[]
    | undefined;
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

function generatePreparedStorageEntriesFromPlans(args: {
  readonly input: BuildStorageManifestEntriesArgs;
  readonly phaseTimings: StorageManifestEntryPhaseTimings;
  readonly resolved: ResolvedStorageManifestEntryPlans;
}): Computed<Promise<PreparedStorageEntries>> {
  return computed(async (get) => {
    const finalStoragePlans = mergeStorageEntries({
      composeEntries: args.resolved.composePlans,
      additionalEntries: args.resolved.additionalPlans,
      mountPath(plan) {
        return plan.mountPath;
      },
    });
    const finalComposePlans = finalStoragePlans.filter((plan) => {
      return plan.entryKind === "compose";
    });
    const finalAdditionalPlans = finalStoragePlans.filter((plan) => {
      return plan.entryKind === "additional";
    });

    const [composeEntries, additionalEntries, writebackEntries] =
      await Promise.all([
        args.phaseTimings.compose.measureGenerate(() => {
          return get(
            buildStorageEntriesFromPlans({
              db: args.input.db,
              bucket: args.input.bucket,
              plans: finalComposePlans,
              stats: args.input.stats,
            }),
          );
        }),
        args.phaseTimings.additional.measureGenerate(() => {
          return get(
            buildStorageEntriesFromPlans({
              db: args.input.db,
              bucket: args.input.bucket,
              plans: finalAdditionalPlans,
              stats: args.input.stats,
            }),
          );
        }),
        args.phaseTimings.artifact.measureGenerate(async () => {
          const requests = args.resolved.artifactInputs.flatMap((input) => {
            return input.resolved.fileCount === 0
              ? []
              : [
                  readOnlyStoragePresignedUrlRequest({
                    bucket: args.input.bucket,
                    resolved: input.resolved,
                  }),
                ];
          });
          const urlsByCacheKey = await get(
            resolveReadOnlyStoragePresignedUrls({
              db: args.input.db,
              requests,
            }),
          );
          return args.resolved.artifactInputs.map((input) => {
            if (input.resolved.fileCount === 0) {
              return buildPreparedWritebackStorageEntry({
                bucket: args.input.bucket,
                input,
                archiveUrl: undefined,
                cacheStatus: undefined,
                stats: args.input.stats,
              });
            }
            const request = readOnlyStoragePresignedUrlRequest({
              bucket: args.input.bucket,
              resolved: input.resolved,
            });
            const result = urlsByCacheKey.get(
              readOnlyStoragePresignedUrlCacheKey(request),
            );
            return buildPreparedWritebackStorageEntry({
              bucket: args.input.bucket,
              input,
              archiveUrl: result?.url,
              cacheStatus: result?.status,
              stats: args.input.stats,
            });
          });
        }),
      ]);

    return {
      composeEntries,
      additionalEntries,
      writebackEntries,
      resolvedComposeEntryCount: args.resolved.composePlans.length,
      resolvedAdditionalEntryCount: args.resolved.additionalPlans.length,
    };
  });
}

function buildPreparedStorageEntries(
  args: BuildStorageManifestEntriesArgs,
): Computed<Promise<PreparedStorageEntries>> {
  return computed(async (get) => {
    const phaseTimings = createStorageManifestEntryPhaseTimings({
      timing: args.timing,
      stats: args.stats,
    });

    return await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_prepare_storage_manifest_build_entries",
      "nested",
      async () => {
        return await (async () => {
          const resolved = await resolveStorageManifestEntryPlans({
            input: args,
            phaseTimings,
          });
          return await get(
            generatePreparedStorageEntriesFromPlans({
              input: args,
              phaseTimings,
              resolved,
            }),
          );
        })().finally(() => {
          phaseTimings.compose.flush();
          phaseTimings.additional.flush();
          phaseTimings.artifact.flush();
        });
      },
      () => {
        return args.stats?.buildEntriesDimensions();
      },
    );
  });
}

function persistedMountIdentity(
  mount: Pick<PersistedStorageMount, "name" | "mountPath">,
): string {
  return JSON.stringify([mount.name, mount.mountPath]);
}

function assertUniquePersistedMountPaths(
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

async function resolvePersistedStorageMounts(args: {
  readonly db: Db;
  readonly index: StorageIndex;
  readonly mounts: readonly PersistedStorageMount[];
}): Promise<ResolvedStorageManifestEntryPlans> {
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

    const resolvedResult = await settle(
      resolveStorageVersion(args.db, args.index, lookup, mount.version),
    );
    if (!resolvedResult.ok) {
      if (mount.optional && isMissingStorageError(resolvedResult.error)) {
        continue;
      }
      throw resolvedResult.error;
    }
    const resolved = resolvedResult.value;

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

function buildEntriesFromPersistedStorageMounts(args: {
  readonly db: Db;
  readonly bucket: string;
  readonly mounts: readonly PersistedStorageMount[];
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Computed<Promise<PreparedStorageEntries>> {
  return computed(async (get) => {
    assertUniquePersistedMountPaths(args.mounts);
    const storageIndex = await loadTimedStorageIndex({
      db: args.db,
      requests: args.mounts.map((mount) => {
        return {
          lookup: {
            orgId: mount.orgId,
            userId: mount.userId,
            name: mount.name,
          },
          version: mount.version,
        };
      }),
      timing: args.timing,
    });
    const phaseTimings = createStorageManifestEntryPhaseTimings(args);
    return await (async () => {
      const input: BuildStorageManifestEntriesArgs = {
        db: args.db,
        bucket: args.bucket,
        storageIndex,
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
      const resolved = await resolvePersistedStorageMounts({
        db: args.db,
        index: storageIndex,
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
      return await get(
        generatePreparedStorageEntriesFromPlans({
          input,
          phaseTimings,
          resolved,
        }),
      );
    })().finally(() => {
      phaseTimings.compose.flush();
      phaseTimings.additional.flush();
      phaseTimings.artifact.flush();
    });
  });
}

function combinePreparedStorageEntries(args: {
  readonly requested: PreparedStorageEntries;
  readonly sessionWriteback: PreparedStorageEntries;
}): PreparedStorageEntries {
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

async function finalizePreparedStorage(args: {
  readonly entries: PreparedStorageEntries;
  readonly timing?: ApiDispatchTimingCollector;
  readonly stats?: StorageManifestBuildStats;
}): Promise<PreparedAgentRunStorage> {
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

interface SessionStorageOverlay {
  readonly canonicalWritebackMounts: readonly PersistedStorageMount[];
  readonly remainingArtifacts: readonly ContextArtifact[];
}

function resolveSessionStorageOverlay(args: {
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

function buildPreparedStorageEntriesForRequest(
  args: PrepareAgentRunStorageManifestArgs,
  bucket: string,
  composeVolumes: readonly ResolvedVolume[],
  artifacts: readonly ContextArtifact[],
): Computed<Promise<PreparedStorageEntries>> {
  return computed(async (get) => {
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

    await get(
      ensureStorageManifestArtifacts({
        db: args.db,
        runtimeOrgId: args.runtimeOrgId,
        userId: args.userId,
        artifacts,
        timing: args.timing,
        stats: args.stats,
      }),
    );

    const storageIndex = await loadTimedStorageIndex({
      db: args.db,
      requests: storageManifestRequests({
        agentOrgId: args.agentOrgId,
        runtimeOrgId: args.runtimeOrgId,
        userId: args.userId,
        composeVolumes,
        additionalVolumes: args.additionalVolumes,
        additionalVolumeSources,
        artifacts,
      }),
      timing: args.timing,
    });

    return await get(
      buildPreparedStorageEntries({
        db: args.db,
        bucket,
        storageIndex,
        agentOrgId: args.agentOrgId,
        runtimeOrgId: args.runtimeOrgId,
        userId: args.userId,
        composeVolumes,
        additionalVolumes: args.additionalVolumes,
        additionalVolumeSources,
        artifacts,
        timing: args.timing,
        stats: args.stats,
      }),
    );
  });
}

function prepareStorageWithSessionOverlay(
  args: PrepareAgentRunStorageManifestArgs,
  bucket: string,
): Computed<Promise<PreparedAgentRunStorage>> {
  return computed(async (get) => {
    const { artifacts, composeVolumes } =
      await resolveStorageManifestInputs(args);
    const { canonicalWritebackMounts, remainingArtifacts } =
      resolveSessionStorageOverlay({
        artifacts,
        persistedStorageMounts: args.persistedStorageMounts,
      });
    const requestedEntriesPromise = get(
      buildPreparedStorageEntriesForRequest(
        args,
        bucket,
        composeVolumes,
        remainingArtifacts,
      ),
    );
    const sessionWritebackEntriesPromise =
      canonicalWritebackMounts.length === 0
        ? Promise.resolve(undefined)
        : get(
            buildEntriesFromPersistedStorageMounts({
              db: args.db,
              bucket,
              mounts: canonicalWritebackMounts,
              timing: args.timing,
              stats: args.stats,
            }),
          );
    const [requestedEntriesResult, sessionWritebackEntriesResult] =
      await Promise.allSettled([
        requestedEntriesPromise,
        sessionWritebackEntriesPromise,
      ]);
    if (requestedEntriesResult.status === "rejected") {
      throw requestedEntriesResult.reason;
    }
    if (sessionWritebackEntriesResult.status === "rejected") {
      throw sessionWritebackEntriesResult.reason;
    }
    const entries =
      sessionWritebackEntriesResult.value === undefined
        ? requestedEntriesResult.value
        : combinePreparedStorageEntries({
            requested: requestedEntriesResult.value,
            sessionWriteback: sessionWritebackEntriesResult.value,
          });
    return await finalizePreparedStorage({
      entries,
      timing: args.timing,
      stats: args.stats,
    });
  });
}

export function prepareAgentRunStorage(
  args: PrepareAgentRunStorageManifestArgs,
): Computed<Promise<PreparedAgentRunStorage>> {
  return computed(async (get): Promise<PreparedAgentRunStorage> => {
    const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
    return await get(prepareStorageWithSessionOverlay(args, bucket));
  });
}
