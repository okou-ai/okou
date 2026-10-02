import { computed, command, type Computed, type Command } from "ccstate";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/schema/system-storage-presigned-url-cache";
import {
  SYSTEM_ORG_ID,
  VOLUME_ORG_USER_ID,
  getCustomSkillStorageName,
  MEMORY_ARTIFACT_NAME,
} from "@okouai/core/storage-names";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { publicPresignedGetUrlSigner$ } from "../external/s3";
import { settle } from "../utils";
import {
  signStorageManifestPresignedUrls,
  storageManifestPresignedUrlCacheLookupPairs,
  systemStoragePresignedUrlCacheKey,
  workflowSkillStoragePresignedUrlCacheKey,
  readOnlyStoragePresignedUrlCacheKey,
  type StorageManifestPresignedUrlCacheScope,
  type SelectedStoragePresignedUrlCacheRow,
  type SystemStoragePresignedUrlCacheStatus,
  type WorkflowSkillStoragePresignedUrlCacheStatus,
  type StorageManifestCacheEntryKind,
} from "./system-storage-presigned-url-cache.service";
import {
  measureApiDispatchTiming,
  ApiDispatchTimingCollector,
  type ApiDispatchTimingDimensions,
} from "./api-dispatch-timing.service";
import type { PersistedStorageMount } from "@okouai/db/types";
import type { StoredStorageMountEntry } from "@okouai/api-contracts/contracts/runners";
import type { RunContextResponse } from "@okouai/api-contracts/contracts/run-routes";
import { normalizeMountOverlay } from "./storage-mount-overlay";

export interface ExecutionStorageIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly storageId: string;
  readonly versionId: string;
  readonly name: string;
  readonly mountPath: string;
}

export interface ReadOnlyStorageRequest extends ExecutionStorageIdentity {
  readonly mode: "readonly";
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
}

export interface WritebackStorageRequest extends ExecutionStorageIdentity {
  readonly mode: "writeback";
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export type ExecutionStorageRequest =
  | ReadOnlyStorageRequest
  | WritebackStorageRequest;
export type PreparedStorageIdentity = ExecutionStorageIdentity;

export interface PreparedReadOnlyMount extends PreparedStorageIdentity {
  readonly writeback: false;
  readonly archiveUrl: string;
  readonly archiveSize: number;
  readonly baselineCandidate?: true;
  readonly instructionsTargetFilename?: string;
}

export interface PreparedArchivedWritebackMount extends PreparedStorageIdentity {
  readonly writeback: true;
  readonly empty: false;
  readonly archiveUrl: string;
  readonly archiveSize: number;
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export interface PreparedEmptyWritebackMount extends PreparedStorageIdentity {
  readonly writeback: true;
  readonly empty: true;
  readonly missingRootPolicy: "fail" | "preserveParentVersion";
}

export type PreparedExecutionStorageMount =
  | PreparedReadOnlyMount
  | PreparedArchivedWritebackMount
  | PreparedEmptyWritebackMount;
export interface ExecutionStorageObjects {
  readonly preparedMounts$: Computed<
    Promise<readonly PreparedExecutionStorageMount[]>
  >;
  readonly updatePresignedUrlCache$: Command<
    Promise<void>,
    [signal: AbortSignal]
  >;
}

type CacheInput = Parameters<
  typeof signStorageManifestPresignedUrls
>[0]["input"];
type CacheSnapshot = Parameters<
  typeof signStorageManifestPresignedUrls
>[0]["prefetchedRows"];
type FreshCacheValues = Awaited<
  ReturnType<typeof signStorageManifestPresignedUrls>
>["freshValues"];
const log = logger("ExecutionStorage");

function mountKey(mount: ExecutionStorageIdentity): string {
  return JSON.stringify([
    mount.orgId,
    mount.userId,
    mount.storageId,
    mount.versionId,
    mount.name,
  ]);
}

function validateRequests(mounts: readonly ExecutionStorageRequest[]): void {
  const paths = new Set<string>();
  for (const mount of mounts) {
    if (
      !mount.orgId ||
      !mount.userId ||
      !mount.storageId ||
      !mount.versionId ||
      !mount.name ||
      !mount.mountPath
    ) {
      throw new Error(
        "Execution storage requires complete owner, version and mount identities",
      );
    }
    if (paths.has(mount.mountPath)) {
      throw new Error(`Duplicate storage mount path "${mount.mountPath}"`);
    }
    paths.add(mount.mountPath);
    if (mount.mode === "writeback") {
      if (mount.orgId === SYSTEM_ORG_ID) {
        throw new Error("System storage cannot be mounted for writeback");
      }
      if (
        mount.missingRootPolicy !== "fail" &&
        mount.missingRootPolicy !== "preserveParentVersion"
      ) {
        throw new Error("Invalid writeback missing-root policy");
      }
      if (
        "baselineCandidate" in mount ||
        "instructionsTargetFilename" in mount
      ) {
        throw new Error("Read-only mount options cannot be used for writeback");
      }
    } else if (mount.mode !== "readonly" || "missingRootPolicy" in mount) {
      throw new Error("Invalid read-only storage mount configuration");
    }
  }
}

async function readExactVersions(
  db: Pick<ReadonlyDb, "select">,
  mounts: readonly ExecutionStorageRequest[],
) {
  if (mounts.length === 0) {
    return [];
  }
  const unique = [
    ...new Map(
      mounts.map((mount) => {
        return [mountKey(mount), mount];
      }),
    ).values(),
  ];
  const rows = await db
    .select({
      orgId: storages.orgId,
      userId: storages.userId,
      storageId: storages.id,
      name: storages.name,
      versionId: storageVersions.id,
      s3Key: storageVersions.s3Key,
      archiveSize: storageVersions.archiveSize,
      fileCount: storageVersions.fileCount,
    })
    .from(storages)
    .innerJoin(
      sql`unnest(
    ${sql.param(
      unique.map((mount) => {
        return mount.orgId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((mount) => {
        return mount.userId;
      }),
    )}::text[],
    ${sql.param(
      unique.map((mount) => {
        return mount.storageId;
      }),
    )}::uuid[],
    ${sql.param(
      unique.map((mount) => {
        return mount.versionId;
      }),
    )}::varchar(64)[],
    ${sql.param(
      unique.map((mount) => {
        return mount.name;
      }),
    )}::varchar(256)[]
  ) AS requested(org_id, user_id, storage_id, version_id, name)`,
      and(
        eq(storages.orgId, sql`requested.org_id`),
        eq(storages.userId, sql`requested.user_id`),
        eq(storages.id, sql`requested.storage_id`),
        eq(storages.name, sql`requested.name`),
      ),
    )
    .innerJoin(
      storageVersions,
      and(
        eq(storageVersions.storageId, storages.id),
        eq(storageVersions.id, sql`requested.version_id`),
      ),
    );
  const found = new Map(
    rows.map((row) => {
      return [mountKey({ ...row, mountPath: "" }), row];
    }),
  );
  for (const mount of unique) {
    const row = found.get(mountKey(mount));
    if (!row) {
      throw new Error(
        `Requested storage version is unavailable: ${mount.storageId}/${mount.versionId}`,
      );
    }
    if (
      !Number.isSafeInteger(row.archiveSize) ||
      row.archiveSize < 0 ||
      !Number.isSafeInteger(row.fileCount) ||
      row.fileCount < 0 ||
      !row.s3Key
    ) {
      throw new Error("Invalid persisted execution storage version");
    }
  }
  return rows;
}

type VersionRow = Awaited<ReturnType<typeof readExactVersions>>[number];

function cacheRequest(
  mount: ExecutionStorageRequest,
  version: VersionRow,
  bucket: string,
) {
  const request = {
    bucket,
    objectKey: `${version.s3Key}/archive.tar.gz`,
    storageVersionId: version.versionId,
    resolvedOrgId: version.orgId,
    publicEndpoint: true,
  };
  // These are storage/cache namespaces, not Thread/workflow selection policy.
  if (mount.orgId === SYSTEM_ORG_ID) {
    return {
      scope: "system_storage" as const,
      request,
      key: systemStoragePresignedUrlCacheKey(request),
    };
  }
  if (
    mount.mode === "readonly" &&
    mount.userId === VOLUME_ORG_USER_ID &&
    mount.name.startsWith(getCustomSkillStorageName(""))
  ) {
    return {
      scope: "workflow_skill_storage" as const,
      request,
      key: workflowSkillStoragePresignedUrlCacheKey(request),
    };
  }
  return {
    scope: "readonly_storage" as const,
    request,
    key: readOnlyStoragePresignedUrlCacheKey(request),
  };
}

function signingRequests(
  mounts: readonly ExecutionStorageRequest[],
  rows: readonly VersionRow[],
  bucket: string,
) {
  const versions = new Map(
    rows.map((row) => {
      return [mountKey({ ...row, mountPath: "" }), row];
    }),
  );
  const selected = mounts.map((mount) => {
    const version = versions.get(mountKey(mount));
    if (!version) {
      throw new Error("Validated storage version is missing");
    }
    return {
      mount,
      version,
      cache:
        mount.mode === "writeback" && version.fileCount === 0
          ? undefined
          : cacheRequest(mount, version, bucket),
    };
  });
  const input: CacheInput = {
    systemRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "system_storage" ? [cache.request] : [];
    }),
    workflowSkillRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "workflow_skill_storage" ? [cache.request] : [];
    }),
    readOnlyRequests: selected.flatMap(({ cache }) => {
      return cache?.scope === "readonly_storage" ? [cache.request] : [];
    }),
    logicalLookupCount: new Set(
      selected.flatMap(({ cache }) => {
        return cache ? [cache.scope] : [];
      }),
    ).size,
  };
  return { selected, input };
}

function preparedMounts(
  requests: ReturnType<typeof signingRequests>,
  signed: Awaited<ReturnType<typeof signStorageManifestPresignedUrls>>,
): readonly PreparedExecutionStorageMount[] {
  return requests.selected.map(
    ({ mount, version, cache }): PreparedExecutionStorageMount => {
      const identity = {
        orgId: mount.orgId,
        userId: mount.userId,
        storageId: mount.storageId,
        versionId: mount.versionId,
        name: mount.name,
        mountPath: mount.mountPath,
      };
      if (mount.mode === "writeback" && version.fileCount === 0) {
        return {
          ...identity,
          writeback: true,
          empty: true,
          missingRootPolicy: mount.missingRootPolicy,
        };
      }
      const archiveUrl = cache ? signed.results.get(cache.key)?.url : undefined;
      if (!archiveUrl) {
        throw new Error("Prepared storage URL is missing");
      }
      if (mount.mode === "writeback") {
        return {
          ...identity,
          writeback: true,
          empty: false,
          archiveUrl,
          archiveSize: version.archiveSize,
          missingRootPolicy: mount.missingRootPolicy,
        };
      }
      return {
        ...identity,
        writeback: false,
        archiveUrl,
        archiveSize: version.archiveSize,
        ...(mount.baselineCandidate
          ? { baselineCandidate: mount.baselineCandidate }
          : {}),
        ...(mount.instructionsTargetFilename === undefined
          ? {}
          : { instructionsTargetFilename: mount.instructionsTargetFilename }),
      };
    },
  );
}

/** Cache persistence is an explicit log-only exception, owned after commit. */
const persistPresignedUrlCache$ = command(
  async (
    { set },
    values: FreshCacheValues,
    signal: AbortSignal,
  ): Promise<void> => {
    signal.throwIfAborted();
    const unique = [
      ...new Map(
        values.map((value) => {
          return [value.cacheKey, value];
        }),
      ).values(),
    ].sort((a, b) => {
      return a.cacheKey.localeCompare(b.cacheKey);
    });
    if (unique.length === 0) {
      return;
    }
    const excluded = alias(systemStoragePresignedUrlCache, "excluded");
    const result = await settle(
      set(writeDb$)
        .insert(systemStoragePresignedUrlCache)
        .values(unique)
        .onConflictDoUpdate({
          target: systemStoragePresignedUrlCache.cacheKey,
          set: {
            scope: excluded.scope,
            bucket: excluded.bucket,
            objectKey: excluded.objectKey,
            storageVersionId: excluded.storageVersionId,
            resolvedOrgId: excluded.resolvedOrgId,
            publicEndpoint: excluded.publicEndpoint,
            ttlSeconds: excluded.ttlSeconds,
            presignedUrl: excluded.presignedUrl,
            expiresAt: excluded.expiresAt,
            refreshAfter: excluded.refreshAfter,
            lastRequestedAt: excluded.lastRequestedAt,
            updatedAt: excluded.updatedAt,
          },
        }),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      log.error("Failed to update execution storage presigned URL cache", {
        cacheEntryCount: unique.length,
        error: result.error,
      });
    }
  },
);

/** Exact identity reads and local signing only; no HEAD selection or storage initialization. */
export function createExecutionStorageObjects(
  mounts: readonly ExecutionStorageRequest[],
): ExecutionStorageObjects {
  const versions$ = computed(async (get) => {
    validateRequests(mounts);
    return await readExactVersions(get(db$), mounts);
  });
  const requests$ = computed(async (get) => {
    return signingRequests(
      mounts,
      await get(versions$),
      env("R2_USER_STORAGES_BUCKET_NAME"),
    );
  });
  const cacheRows$ = computed(async (get): Promise<CacheSnapshot> => {
    const { input } = await get(requests$);
    const { pairs, cacheKeysByRequest } =
      storageManifestPresignedUrlCacheLookupPairs(input, false);
    const scopes: readonly StorageManifestPresignedUrlCacheScope[] = [
      "system_storage",
      "workflow_skill_storage",
      "readonly_storage",
    ];
    const conditions = scopes.flatMap((scope) => {
      const keys = pairs
        .filter((pair) => {
          return pair.scope === scope;
        })
        .map((pair) => {
          return pair.cacheKey;
        });
      return keys.length === 0
        ? []
        : [
            and(
              eq(systemStoragePresignedUrlCache.scope, scope),
              inArray(systemStoragePresignedUrlCache.cacheKey, keys),
            ),
          ];
    });
    const rows =
      conditions.length === 0
        ? []
        : await get(db$)
            .select({
              scope: systemStoragePresignedUrlCache.scope,
              cacheKey: systemStoragePresignedUrlCache.cacheKey,
              presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
              expiresAt: systemStoragePresignedUrlCache.expiresAt,
            })
            .from(systemStoragePresignedUrlCache)
            .where(or(...conditions));
    const rowsByScope = new Map<
      StorageManifestPresignedUrlCacheScope,
      Map<string, SelectedStoragePresignedUrlCacheRow>
    >();
    for (const row of rows) {
      if (
        row.scope !== "system_storage" &&
        row.scope !== "workflow_skill_storage" &&
        row.scope !== "readonly_storage"
      ) {
        throw new Error("Unexpected execution storage cache scope");
      }
      let scoped = rowsByScope.get(row.scope);
      if (!scoped) {
        scoped = new Map();
        rowsByScope.set(row.scope, scoped);
      }
      scoped.set(row.cacheKey, row);
    }
    return { rowsByScope, cacheKeysByRequest };
  });
  const signed$ = computed(async (get) => {
    const [requests, rows] = await Promise.all([
      get(requests$),
      get(cacheRows$),
    ]);
    return await signStorageManifestPresignedUrls({
      input: requests.input,
      prefetchedRows: rows,
      sign: get(publicPresignedGetUrlSigner$),
    });
  });
  const preparedMounts$ = computed(async (get) => {
    if (mounts.length === 0) {
      return [];
    }
    const [requests, signed] = await Promise.all([
      get(requests$),
      get(signed$),
    ]);
    return preparedMounts(requests, signed);
  });
  const updatePresignedUrlCache$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      if (mounts.length === 0) {
        return;
      }
      const signed = await get(signed$);
      signal.throwIfAborted();
      await set(persistPresignedUrlCache$, signed.freshValues, signal);
    },
  );
  return { preparedMounts$, updatePresignedUrlCache$ };
}

// --- Private implementation: storage manifest ---

// Storage planning and explicit resource materialization.

export type StorageManifestEntryKind = StorageManifestCacheEntryKind;

type StorageManifestCountBucket =
  (typeof STORAGE_MANIFEST_COUNT_BUCKET_DIMENSIONS)[number];

interface PresignCandidateInput {
  readonly bucket: string;
  readonly key: string;
  readonly expiresIn: number;
  readonly filename: string | undefined;
  readonly usePublicEndpoint: boolean;
}

export interface ContextArtifact {
  readonly name: string;
  readonly version?: string;
  readonly mountPath: string;
  readonly missingRootPolicy?: PersistedStorageMount["missingRootPolicy"];
}

export interface StorageResolution {
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
export type StorageMountMetadata = Omit<StoredStorageMountEntry, "archiveUrl">;

export interface PreparedReadOnlyStorageEntry<
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

export interface PreparedStorageEntries<
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

export interface ResolvedManifestArtifactInput {
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

export function knownArchiveSize(
  resolved: StorageResolution,
): number | undefined {
  return Number.isSafeInteger(resolved.archiveSize) && resolved.archiveSize > 0
    ? resolved.archiveSize
    : undefined;
}

export function writebackStorageEntryMetadata(
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

export function mergeStorageEntries<TEntry>(args: {
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

// Execution context, launch preparation and pending atomic commit.

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
    ...(prepared.baselineCandidate
      ? { baselineCandidate: prepared.baselineCandidate }
      : {}),
    ...(prepared.instructionsTargetFilename === undefined
      ? {}
      : { instructionsTargetFilename: prepared.instructionsTargetFilename }),
  };
}
// --- Private implementation: launch persistence ---

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
