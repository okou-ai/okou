import { performance } from "node:perf_hooks";
import { computed, type Computed } from "ccstate";
import { isValidVersionPrefix } from "@okouai/core/version-id";
import { storageVersions } from "@okouai/db/schema/storage";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { storageVersionCacheKeySql } from "./execution-storage-cache-read.service";
import {
  createResolvedExecutionStorageObjects,
  type ExecutionStorageRequest,
  type PreparedExecutionStorageMount,
} from "./execution-storage.service";
import { resolvePreparedPiModelConfig } from "./pi-sandbox-config";
import {
  type AgentRunStorageInput,
  type AgentRunStoragePlan,
  type AgentRunStorageSelection,
  assertUniquePersistedMountPaths,
  finalizePreparedStorage,
  type MaterializedAgentRunStorage,
  persistedStorageMountRequests,
  prepareRequestStorageResolution,
  prepareRunOutputMetadata,
  resolveStorageEntries,
  resolveStorageManifestInputs,
  resolveValidatedPersistedStorageMounts,
  StorageManifestBuildStats,
  storageEntriesMetadata,
  storageIndexKey,
  storageIndexWithPrefixVersions,
  storagePrefixVersionRequests,
  storedMountFromPrepared,
} from "./run-storage-manifest.service";
import {
  exactStorageVersionsFromIndex,
  mergeStorageIndexes,
  storageBaseIndexFromRows,
  storageBaseIndexReadPlan,
  storageRequestKey,
} from "./storage-index.service";
import type { ThreadContext } from "./thread-context.signals";
import type { ThreadModelError } from "./thread-model.signals";
import type { PromptAndSkillVolumes } from "./thread-run-prompt/prompt-and-skill-volumes";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

function isThreadModelError(value: unknown): value is ThreadModelError {
  return typeof value === "object" && value !== null && "status" in value;
}

/** The Run's storage: resolved mounts, prepared manifest and cache writes. */
export interface Storage extends MaterializedAgentRunStorage {
  /** Exact mounts and signed URLs recorded in the presigned URL cache. */
  readonly presignedUrlCache: {
    readonly mounts: readonly ExecutionStorageRequest[];
    readonly prepared: readonly PreparedExecutionStorageMount[];
  };
}

/** A prompt bundle or other source that declares the Run's skill volumes. */
export type SkillVolumeSource = Computed<
  Promise<Pick<PromptAndSkillVolumes, "skillVolumes">>
>;

/**
 * The Run's storage from its current Agent, model and skill volumes: resolved
 * versions, mounts, writeback targets and signed URLs.
 */
export function createStorageSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
  skillVolumeSources: readonly SkillVolumeSource[],
) {
  const storageInput$ = createStorageInputSignal(
    bootstrap,
    pickedEvent$,
    threadContext,
    skillVolumeSources,
  );
  const index = createStorageIndexSignals(threadContext, storageInput$);
  const plan = createStoragePlanSignals(index);
  const objects = createStorageObjectSignals(threadContext, plan);
  const { selectedStorageMetadata$, executionStorageObjects$ } = objects;
  return computed(async (get): Promise<Storage> => {
    const [selected, storage] = await Promise.all([
      get(selectedStorageMetadata$),
      get(executionStorageObjects$),
    ]);
    const spanTiming = selected.plan.requested.input.timing;
    const spanStartedAt = spanTiming ? performance.now() : undefined;
    const mounts = await (async () => {
      return await get(storage.objects.preparedMounts$);
    })().finally(() => {
      if (spanTiming && spanStartedAt !== undefined) {
        spanTiming.recordDuration(
          "api_dispatch_prepare_storage_manifest_generate_compose_urls",
          "nested",
          performance.now() - spanStartedAt,
          now(),
          { storage_manifest_signing_owner: "execution_storage" },
        );
      }
    });
    const byPath = new Map(
      mounts.map((mount) => {
        return [mount.mountPath, mount];
      }),
    );
    const attach = (
      mount: MaterializedAgentRunStorage["resolved"]["metadata"]["storageMounts"][number],
    ) => {
      const prepared = byPath.get(mount.mountPath);
      if (!prepared) {
        throw new Error("Selected storage mount has no prepared result");
      }
      return storedMountFromPrepared(
        prepared,
        mount.missingRootPolicy !== undefined,
      );
    };
    const entries = {
      ...selected.entries,
      composeEntries: selected.entries.composeEntries.map((entry) => {
        return {
          ...entry,
          storedMount: attach(entry.storedMount),
        };
      }),
      additionalEntries: selected.entries.additionalEntries.map((entry) => {
        return {
          ...entry,
          storedMount: attach(entry.storedMount),
        };
      }),
      writebackEntries: selected.entries.writebackEntries.map((entry) => {
        return {
          ...entry,
          storedMount: attach(entry.storedMount),
        };
      }),
    };
    const prepared = await finalizePreparedStorage({
      entries,
      timing: selected.plan.requested.input.timing,
      stats: selected.plan.requested.input.stats,
    });
    return {
      resolved: {
        metadata: selected.metadata,
        requested: selected.plan.requested,
      },
      prepared,
      presignedUrlCache: { mounts: storage.mounts, prepared: mounts },
    };
  });
}

function createStorageInputSignal(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
  skillVolumeSources: readonly SkillVolumeSource[],
) {
  return computed(async (get): Promise<AgentRunStorageInput> => {
    const [
      event,
      agent,
      framework,
      modelProvider,
      selection,
      officialWorkflow,
      catalog,
      skillBundles,
    ] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.agent$),
      get(threadContext.providerFramework$),
      get(threadContext.modelRoute$),
      get(threadContext.subscriptionSelection$),
      get(threadContext.officialWorkflowObservation$),
      get(bootstrap.modelCatalog$),
      Promise.all(
        skillVolumeSources.map((source$) => {
          return get(source$);
        }),
      ),
    ]);
    if (!event || !agent) {
      throw new Error("Run storage requires its picked event and Agent");
    }
    if (
      isThreadModelError(framework) ||
      isThreadModelError(modelProvider) ||
      isThreadModelError(selection)
    ) {
      throw new Error("Run storage requires an admitted model selection");
    }
    const resolved = {
      orgId: agent.orgId,
    };
    const piSandbox = resolvePreparedPiModelConfig({
      input: {
        catalog,
        piExecution: selection.piExecution,
        codexServiceTier: selection.codexServiceTier,
        reasoningEffort: selection.reasoningEffort,
      },
      modelProvider,
    });
    const metadata = prepareRunOutputMetadata({
      skillVolumes: skillBundles.flatMap((bundle) => {
        return bundle.skillVolumes;
      }),
      officialWorkflow,
      framework,
      piSandbox,
      body: {},
      resolved,
    });
    // Initialize the existing database dependency before returning captured data.
    get(db$);
    return {
      kind: "requested",
      args: {
        agentOrgId: resolved.orgId,
        runtimeOrgId: bootstrap.orgId,
        userId: bootstrap.userId,
        artifacts: metadata.artifacts,
        additionalVolumes: metadata.additionalVolumes,
        additionalVolumeSources: metadata.additionalVolumeSources,
        framework: piSandbox === undefined ? framework : "pi",
        timing: get(threadContext.dispatchTiming$),
        stats: new StorageManifestBuildStats(),
      },
    };
  });
}

type StorageInput$ = ReturnType<typeof createStorageInputSignal>;

function createStorageBaseIndexSignal(
  threadContext: ThreadContext,
  storageInput$: StorageInput$,
) {
  const storageSelection$ = computed(
    async (get): Promise<AgentRunStorageSelection> => {
      const input = await get(storageInput$);
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      if (input.kind === "captured") {
        if (
          input.args.mounts.some((mount) => {
            return (
              mount.version === undefined ||
              !/^[0-9a-f]{64}$/u.test(mount.version)
            );
          })
        ) {
          throw new Error("Captured Pi storage must pin every version");
        }
        assertUniquePersistedMountPaths(input.args.mounts);
        return {
          kind: "captured",
          args: input.args,
          bucket,
          requests: persistedStorageMountRequests(input.args.mounts),
        };
      }
      const { artifacts, composeVolumes } = await resolveStorageManifestInputs({
        framework: input.args.framework,
        artifacts: input.args.artifacts,
        timing: input.args.timing,
      });
      const request = prepareRequestStorageResolution(
        {
          agentOrgId: input.args.agentOrgId,
          runtimeOrgId: input.args.runtimeOrgId,
          userId: input.args.userId,
          artifacts: input.args.artifacts,
          additionalVolumes: input.args.additionalVolumes,
          additionalVolumeSources: input.args.additionalVolumeSources,
          timing: input.args.timing,
          stats: input.args.stats,
        },
        bucket,
        composeVolumes,
        artifacts,
      );
      return {
        kind: "requested",
        args: input.args,
        bucket,
        request,
        requests: request.requests,
      };
    },
  );
  const capturedStorageBaseIndex$ = computed(async (get) => {
    const selection = await get(storageSelection$);
    const db = get(db$);
    const input = {
      requests: selection.requests,
      timing: selection.args.timing,
    };
    const prefetched = await get(threadContext.storage$);
    const ownedRequests = input.requests.filter((request) => {
      return !prefetched.lookupKeys.has(
        storageIndexKey(
          request.lookup.orgId,
          request.lookup.userId,
          request.lookup.name,
        ),
      );
    });
    const timing = input.timing;
    const startedAt = timing ? performance.now() : undefined;
    const ownedIndex = await (async () => {
      const readPlan = storageBaseIndexReadPlan(ownedRequests);
      if (readPlan === null) {
        return new Map();
      }
      const rows = await db
        .select(readPlan.columns)
        .from(readPlan.from)
        .innerJoin(readPlan.requested, readPlan.requestedCondition)
        .leftJoin(readPlan.head, readPlan.headCondition)
        .leftJoin(readPlan.exact, readPlan.exactCondition)
        .leftJoin(readPlan.cache, readPlan.cacheCondition);
      return storageBaseIndexFromRows(rows);
    })().finally(() => {
      if (timing && startedAt !== undefined) {
        timing.recordDuration(
          "api_dispatch_prepare_storage_manifest_load_storage_index",
          "nested",
          performance.now() - startedAt,
          now(),
        );
      }
    });
    const index = mergeStorageIndexes(prefetched.index, ownedIndex);
    // Keep the query and its selection together so dependent version reads
    // reuse this snapshot without walking the same upstream graph again.
    const capturedVersionKeys = new Set(
      prefetched.requests.map(storageRequestKey),
    );
    return {
      selection,
      input: {
        ...input,
        requests: input.requests.filter((request) => {
          return !capturedVersionKeys.has(storageRequestKey(request));
        }),
      },
      index,
    };
  });
  return capturedStorageBaseIndex$;
}

function createStorageIndexSignals(
  threadContext: ThreadContext,
  storageInput$: StorageInput$,
) {
  const capturedStorageBaseIndex$ = createStorageBaseIndexSignal(
    threadContext,
    storageInput$,
  );
  const capturedStorageIndex$ = computed(async (get) => {
    const { selection, input, index } = await get(capturedStorageBaseIndex$);
    const db = get(db$);
    return {
      selection,
      storageIndex: await (async () => {
        const queries = [];
        for (const request of storagePrefixVersionRequests(
          input.requests,
          index,
        )) {
          queries.push(
            db
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
              .limit(2),
          );
        }
        const [first, second, ...remaining] = queries;
        const versions = first
          ? await (second ? unionAll(first, second, ...remaining) : first)
          : [];
        return storageIndexWithPrefixVersions(index, versions);
      })(),
    };
  });
  return { capturedStorageIndex$ };
}

function createStoragePlanSignals(
  index: ReturnType<typeof createStorageIndexSignals>,
) {
  const { capturedStorageIndex$ } = index;
  const plan$ = computed(async (get): Promise<AgentRunStoragePlan> => {
    const { selection, storageIndex } = await get(capturedStorageIndex$);
    const spanTiming = selection.args.timing;
    const spanStartedAt = spanTiming ? performance.now() : undefined;
    return await (async () => {
      if (selection.kind === "captured") {
        return {
          requested: await resolveValidatedPersistedStorageMounts({
            mounts: selection.args.mounts,
            timing: selection.args.timing,
            stats: selection.args.stats,
            bucket: selection.bucket,
            storageIndex,
            branch: "captured",
          }),
          missingArtifacts: [],
        };
      }
      const missingArtifacts = selection.request.input.artifacts.filter(
        (artifact) => {
          const entry = storageIndex.get(
            storageIndexKey(
              selection.args.runtimeOrgId,
              selection.args.userId,
              artifact.name,
            ),
          );
          return !entry || entry.headVersionId === null;
        },
      );
      const missingNames = new Set(
        missingArtifacts.map((artifact) => {
          return artifact.name;
        }),
      );
      const requested = await resolveStorageEntries(
        {
          ...selection.request.input,
          artifacts: selection.request.input.artifacts.filter((artifact) => {
            return !missingNames.has(artifact.name);
          }),
          storageIndex,
        },
        "requested",
      );
      return {
        requested: {
          ...requested,
          input: {
            ...requested.input,
            artifacts: selection.request.input.artifacts,
          },
        },
        missingArtifacts,
      };
    })().finally(() => {
      if (spanTiming && spanStartedAt !== undefined) {
        spanTiming.recordDuration(
          "api_dispatch_prepare_storage_manifest_resolve_plan",
          "nested",
          performance.now() - spanStartedAt,
          now(),
        );
      }
    });
  });
  return { plan$ };
}

function createStorageObjectSignals(
  threadContext: ThreadContext,
  plan: ReturnType<typeof createStoragePlanSignals>,
) {
  const { plan$ } = plan;
  const selectedStorageMetadata$ = computed(async (get) => {
    const plan = await get(plan$);
    if (plan.missingArtifacts.length > 0) {
      throw new Error(
        `Run storage must be initialized before execution: ${plan.missingArtifacts
          .map((artifact) => {
            return artifact.name;
          })
          .join(", ")}`,
      );
    }
    const entries = storageEntriesMetadata(plan.requested);
    const metadata = await finalizePreparedStorage({ entries });
    return { plan, entries, metadata };
  });
  const executionStorageObjects$ = computed(async (get) => {
    const selected = await get(selectedStorageMetadata$);
    const mounts = selected.metadata.storageMounts.map(
      (mount): ExecutionStorageRequest => {
        const identity = {
          orgId: mount.orgId,
          userId: mount.userId,
          storageId: mount.storageId,
          versionId: mount.versionId,
          name: mount.name,
          mountPath: mount.mountPath,
        };
        return mount.writeback
          ? {
              ...identity,
              mode: "writeback",
              missingRootPolicy: mount.missingRootPolicy ?? "fail",
            }
          : {
              ...identity,
              mode: "readonly",
            };
      },
    );
    const storageIndex = selected.plan.requested.input.storageIndex;
    const versions = exactStorageVersionsFromIndex(mounts, storageIndex);
    // The index includes the prefetched entries and their cached URLs.
    const rows = [...storageIndex.values()].flatMap((entry) => {
      return entry.cachedUrls ?? [];
    });
    return {
      mounts,
      objects: createResolvedExecutionStorageObjects(mounts, versions, rows),
    };
  });
  return { selectedStorageMetadata$, executionStorageObjects$ };
}
