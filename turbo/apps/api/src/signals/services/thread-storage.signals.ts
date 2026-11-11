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
import { resolvePreparedPiModelConfig } from "./pi-sandbox-config";
import {
  type AgentRunStorageInput,
  type AgentRunStoragePlan,
  type AgentRunStorageSelection,
  finalizePreparedStorage,
  type ResolvedAgentRunStorage,
  prepareRequestStorageResolution,
  prepareRunOutputMetadata,
  resolveStorageEntries,
  resolveStorageManifestInputs,
  StorageManifestBuildStats,
  storageEntriesMetadata,
  storageIndexKey,
  storageIndexWithPrefixVersions,
  storagePrefixVersionRequests,
} from "./run-storage-manifest.service";
import {
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

/** Exact accepted mount intent. Claim owns archive metadata and signed URLs. */
export type Storage = ResolvedAgentRunStorage;

/** A prompt bundle or other source that declares the Run's skill volumes. */
export type SkillVolumeSource = Computed<
  Promise<Pick<PromptAndSkillVolumes, "skillVolumes">>
>;

/**
 * The Run's storage from its current Agent, model and skill volumes: resolved
 * versions, mount paths and writeback targets.
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
  const index = createStorageIndexSignals(bootstrap, storageInput$);
  const plan = createStoragePlanSignals(index);
  const storage$ = createStorageMetadataSignal(plan);
  const output$ = computed(
    async (
      get,
    ): Promise<{
      readonly metadata: ReturnType<typeof prepareRunOutputMetadata>;
      readonly piSandbox: ReturnType<typeof resolvePreparedPiModelConfig>;
    }> => {
      const input = await get(storageInput$);
      return { metadata: input.metadata, piSandbox: input.piSandbox };
    },
  );
  return { storage$, output$ };
}

function createStorageInputSignal(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
  skillVolumeSources: readonly SkillVolumeSource[],
) {
  return computed(async (get) => {
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
    });
    get(db$);
    return {
      metadata,
      piSandbox,
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
    } satisfies AgentRunStorageInput & {
      readonly metadata: typeof metadata;
      readonly piSandbox: typeof piSandbox;
    };
  });
}

type StorageInput$ = ReturnType<typeof createStorageInputSignal>;

function createStorageBaseIndexSignal(
  bootstrap: AgentRunContextSignals,
  storageInput$: StorageInput$,
) {
  const storageSelection$ = computed(
    async (get): Promise<AgentRunStorageSelection> => {
      const input = await get(storageInput$);
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
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
        args: input.args,
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
    const prefetched = await get(bootstrap.storage$);
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
  bootstrap: AgentRunContextSignals,
  storageInput$: StorageInput$,
) {
  const capturedStorageBaseIndex$ = createStorageBaseIndexSignal(
    bootstrap,
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
      const requested = await resolveStorageEntries({
        ...selection.request.input,
        artifacts: selection.request.input.artifacts.filter((artifact) => {
          return !missingNames.has(artifact.name);
        }),
        storageIndex,
      });
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

function createStorageMetadataSignal(
  plan: ReturnType<typeof createStoragePlanSignals>,
) {
  const { plan$ } = plan;
  return computed(async (get): Promise<Storage> => {
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
    const metadata = await finalizePreparedStorage({
      entries,
      timing: plan.requested.input.timing,
      stats: plan.requested.input.stats,
    });
    return { metadata, requested: plan.requested };
  });
}
