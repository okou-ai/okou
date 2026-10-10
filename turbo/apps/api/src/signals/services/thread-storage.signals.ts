import { getInstructionsStorageName } from "@okouai/core/storage-names";
import { computed, type Computed } from "ccstate";
import { env } from "../../lib/env";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { BootstrapAgent } from "./agent-data.service";
import { measureApiDispatchTiming } from "./api-dispatch-timing.service";
import type { ChatThreadSessionResolution } from "./chat-session-continuity.service";
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
  combinePreparedStorageEntries,
  finalizePreparedStorage,
  loadStorageBaseIndex,
  type MaterializedAgentRunStorage,
  persistedStorageMountRequests,
  prepareRequestStorageResolution,
  prepareRunOutputMetadata,
  resolvedSessionStorage,
  resolveSessionStorageOverlay,
  resolveSessionWritebackStorageMounts,
  resolveStorageEntries,
  resolveStorageManifestInputs,
  resolveValidatedPersistedStorageMounts,
  type RunStorageExecution,
  StorageManifestBuildStats,
  storageEntriesMetadata,
  storageIndexKey,
  storedMountFromPrepared,
  withStoragePrefixVersions,
} from "./run-storage-manifest.service";
import {
  exactStorageVersionsFromIndex,
  mergeStorageIndexes,
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
 * The Run's storage from its Agent, session, model and skill volumes: resolved
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
    const mounts = await measureApiDispatchTiming(
      selected.plan.requested.input.timing,
      "api_dispatch_prepare_storage_manifest_generate_compose_urls",
      "nested",
      () => {
        return get(storage.objects.preparedMounts$);
      },
      { storage_manifest_signing_owner: "execution_storage" },
    );
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
        sessionWriteback: selected.plan.sessionWriteback,
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
      session,
      framework,
      modelProvider,
      selection,
      officialWorkflow,
      catalog,
      skillBundles,
    ] = await Promise.all([
      get(pickedEvent$),
      get(bootstrap.agent$),
      get(threadContext.threadSession$),
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
    const resolved = sessionStorageExecution(agent, session ?? undefined);
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
    return {
      kind: "requested",
      args: {
        db: get(db$),
        instructionsStorageName: resolved.instructionsStorageName,
        agentOrgId: resolved.orgId,
        runtimeOrgId: bootstrap.orgId,
        userId: bootstrap.userId,
        artifacts: metadata.artifacts,
        additionalVolumes: metadata.additionalVolumes,
        additionalVolumeSources: metadata.additionalVolumeSources,
        framework: piSandbox === undefined ? framework : "pi",
        persistedStorageMounts: resolved.persistedStorageMounts,
        timing: get(threadContext.dispatchTiming$),
        stats: new StorageManifestBuildStats(),
      },
    };
  });
}

/** Storage from the session the run continues, or the Agent's base storage. */
function sessionStorageExecution(
  agent: Pick<BootstrapAgent, "orgId" | "name">,
  session: ChatThreadSessionResolution | undefined,
): RunStorageExecution {
  const common = {
    orgId: agent.orgId,
    instructionsStorageName: getInstructionsStorageName(agent.name),
  };
  if (!session?.sessionId) {
    return { ...common, artifacts: [] };
  }
  const snapshot = session.executionSnapshot;
  if (!snapshot?.agent) {
    throw new Error("Run storage requires the continued session and Agent");
  }
  return {
    ...common,
    ...resolvedSessionStorage(snapshot.session),
    agentSessionId: session.sessionId,
  };
}

type StorageInput$ = ReturnType<typeof createStorageInputSignal>;

function createStorageIndexSignals(
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
      const { artifacts, composeVolumes } = await resolveStorageManifestInputs(
        input.args,
      );
      const { canonicalWritebackMounts, remainingArtifacts } =
        resolveSessionStorageOverlay({
          artifacts,
          persistedStorageMounts: input.args.persistedStorageMounts,
        });
      const request = prepareRequestStorageResolution(
        input.args,
        bucket,
        composeVolumes,
        remainingArtifacts,
      );
      return {
        kind: "requested",
        args: input.args,
        bucket,
        request,
        remainingArtifacts,
        canonicalWritebackMounts,
        requests: [
          ...request.requests,
          ...persistedStorageMountRequests(canonicalWritebackMounts),
        ],
      };
    },
  );
  const capturedStorageBaseIndex$ = computed(async (get) => {
    const selection = await get(storageSelection$);
    const input = {
      db: selection.args.db,
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
    const index = mergeStorageIndexes(
      prefetched.index,
      await loadStorageBaseIndex(input.db, ownedRequests, input.timing),
    );
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
  const capturedStorageIndex$ = computed(async (get) => {
    const { selection, input, index } = await get(capturedStorageBaseIndex$);
    return {
      selection,
      storageIndex: await withStoragePrefixVersions(
        input.db,
        input.requests,
        index,
      ),
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
    return await measureApiDispatchTiming(
      selection.args.timing,
      "api_dispatch_prepare_storage_manifest_resolve_plan",
      "nested",
      async () => {
        if (selection.kind === "captured") {
          return {
            requested: await resolveValidatedPersistedStorageMounts({
              ...selection.args,
              bucket: selection.bucket,
              storageIndex,
              branch: "captured",
            }),
            sessionWriteback: undefined,
            missingArtifacts: [],
          };
        }
        const missingArtifacts = selection.remainingArtifacts.filter(
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
        const [requested, sessionWriteback] = await Promise.all([
          resolveStorageEntries(
            {
              ...selection.request.input,
              artifacts: selection.remainingArtifacts.filter((artifact) => {
                return !missingNames.has(artifact.name);
              }),
              storageIndex,
            },
            "requested",
          ),
          selection.canonicalWritebackMounts.length === 0
            ? undefined
            : resolveSessionWritebackStorageMounts({
                db: selection.args.db,
                bucket: selection.bucket,
                storageIndex,
                mounts: selection.canonicalWritebackMounts,
                timing: selection.args.timing,
                stats: selection.args.stats,
              }),
        ]);
        return {
          requested: {
            ...requested,
            input: {
              ...requested.input,
              artifacts: selection.remainingArtifacts,
            },
          },
          sessionWriteback,
          missingArtifacts,
        };
      },
    );
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
    const entries =
      plan.sessionWriteback === undefined
        ? storageEntriesMetadata(plan.requested)
        : combinePreparedStorageEntries({
            requested: storageEntriesMetadata(plan.requested),
            sessionWriteback: storageEntriesMetadata(plan.sessionWriteback),
          });
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
              ...(mount.instructionsTargetFilename === undefined
                ? {}
                : {
                    instructionsTargetFilename:
                      mount.instructionsTargetFilename,
                  }),
            };
      },
    );
    const storageIndex = mergeStorageIndexes(
      selected.plan.requested.input.storageIndex,
      selected.plan.sessionWriteback?.input.storageIndex ?? new Map(),
    );
    const cache = await get(threadContext.storageCache$);
    const versions = exactStorageVersionsFromIndex(mounts, storageIndex);
    const rows = [
      ...cache.rows,
      ...[...storageIndex.values()].flatMap((entry) => {
        return entry.cachedUrls ?? [];
      }),
    ];
    return {
      mounts,
      objects: createResolvedExecutionStorageObjects(mounts, versions, rows),
    };
  });
  return { selectedStorageMetadata$, executionStorageObjects$ };
}
