import { performance } from "node:perf_hooks";
import { computed, type Computed } from "ccstate";
import { isValidVersionPrefix } from "@okouai/core/version-id";
import { memoryVersions } from "@okouai/db/schema/member-memory";
import { systemStoragePresignedUrlCache } from "@okouai/db/runtime/system-storage-presigned-url-cache";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { now } from "../../lib/time";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import { storageVersionCacheKeySql } from "./execution-storage-cache-read.service";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import { resolvePreparedPiModelConfig } from "./pi-sandbox-config";
import {
  type AgentRunStorageInput,
  type AgentRunStoragePlan,
  type AgentRunStorageSelection,
  finalizeMemoryMounts,
  prepareRequestStorageResolution,
  memoryArtifactsForRun,
  resolveStorageEntries,
  resolveStorageManifestInputs,
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
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";

function isThreadModelError(value: unknown): value is ThreadModelError {
  return typeof value === "object" && value !== null && "status" in value;
}

/**
 * The Run's memory storage from its current Agent and model: resolved
 * versions, mount paths and writeback targets.
 */
export function createStorageSignals(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  const storageInput$ = createStorageInputSignal(
    bootstrap,
    pickedEvent$,
    threadContext,
  );
  const index = createStorageIndexSignals(bootstrap, storageInput$);
  const plan = createStoragePlanSignals(index);
  return createStorageMetadataSignal(plan);
}

function createStorageInputSignal(
  bootstrap: AgentRunContextSignals,
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  threadContext: ThreadContext,
) {
  return computed(async (get): Promise<AgentRunStorageInput> => {
    const [event, agent, framework, modelProvider, selection, catalog] =
      await Promise.all([
        get(pickedEvent$),
        get(bootstrap.agent$),
        get(threadContext.providerFramework$),
        get(threadContext.modelRoute$),
        get(threadContext.subscriptionSelection$),
        get(bootstrap.modelCatalog$),
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
    const piSandbox = resolvePreparedPiModelConfig({
      input: {
        catalog,
        piExecution: selection.piExecution,
        codexServiceTier: selection.codexServiceTier,
        reasoningEffort: selection.reasoningEffort,
      },
      modelProvider,
    });
    const artifacts = memoryArtifactsForRun({
      framework,
      piSandbox,
    });
    get(db$);
    return {
      args: {
        runtimeOrgId: bootstrap.orgId,
        userId: bootstrap.userId,
        artifacts,
        timing: get(threadContext.dispatchTiming$),
      },
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
      const { artifacts } = await resolveStorageManifestInputs({
        artifacts: input.args.artifacts,
        timing: input.args.timing,
      });
      const request = prepareRequestStorageResolution(
        {
          runtimeOrgId: input.args.runtimeOrgId,
          userId: input.args.userId,
          timing: input.args.timing,
        },
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
    const prefetched = await get(bootstrap.memory$);
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
                storageId: memoryVersions.memoryId,
                id: memoryVersions.id,
                s3Key: memoryVersions.objectPrefix,
                archiveSize: memoryVersions.archiveSize,
                fileCount: memoryVersions.fileCount,
                cacheKey: systemStoragePresignedUrlCache.cacheKey,
                cacheScope: systemStoragePresignedUrlCache.scope,
                presignedUrl: systemStoragePresignedUrlCache.presignedUrl,
                expiresAt: systemStoragePresignedUrlCache.expiresAt,
              })
              .from(memoryVersions)
              .leftJoin(
                systemStoragePresignedUrlCache,
                eq(
                  systemStoragePresignedUrlCache.cacheKey,
                  storageVersionCacheKeySql({
                    orgId: sql`${request.lookup.orgId}`,
                    versionId: sql`${memoryVersions.id}`,
                    s3Key: sql`${memoryVersions.objectPrefix}`,
                  }),
                ),
              )
              .where(
                and(
                  eq(memoryVersions.memoryId, request.storageId),
                  or(
                    eq(memoryVersions.id, request.version),
                    isValidVersionPrefix(request.version)
                      ? like(memoryVersions.id, `${request.version}%`)
                      : undefined,
                  ),
                ),
              )
              .orderBy(desc(eq(memoryVersions.id, request.version)))
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
  return computed(async (get): Promise<readonly AcceptedMemoryMount[]> => {
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
    return await finalizeMemoryMounts(plan.requested);
  });
}
