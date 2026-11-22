import { command, computed, type Computed } from "ccstate";
import { sql } from "drizzle-orm";
import { array, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { monotonicNow, nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { joinAll, type settle } from "../utils";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import {
  type selectExecutionContentBundles,
  signExecutionContentBundles$,
} from "./execution-content-bundle";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import { prepareExecutionRuntimeContext$ } from "./execution-runtime-context";
import type { ExecutionPackageMounts } from "./execution-workflow-selection";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
  type ContentBundleUrlCacheSnapshot,
} from "./content-bundle-presigned-url-cache";
import {
  buildExecutionContext,
  prepareExecutionNetworkPolicy$,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import {
  persistStoragePresignedUrls$,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** Receipt from durable Thread Run admission. */
export interface AdmittedRunLaunch {
  readonly run: ExecutionPublicationRun;
  readonly memoryMount: AcceptedMemoryMount;
  readonly facts: AdmittedExecutionFacts;
  readonly packages: {
    readonly mounts: ExecutionPackageMounts;
    readonly bundles: ReturnType<typeof selectExecutionContentBundles>;
  };
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly createdAt: Date;
  readonly predecessorRunId: string | null;
}

export interface ExecutionBundleCacheObservation {
  readonly bundleUrlCache: ContentBundleUrlCacheSnapshot;
  readonly timing: {
    readonly timestamp: string;
    readonly startedAt: number;
    readonly readyAt: number;
  };
}

export type ExecutionBundleCacheRead = ReturnType<
  typeof settle<ExecutionBundleCacheObservation | null>
>;

export interface DirectRunCachePublication {
  readonly runId: string;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
  readonly bundleCacheRead: {
    readonly startedAt: string;
    readonly durationMs: number;
    readonly consumerWaitMs: number;
  };
}

const bundleCacheRowSchema = object({
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

export function createExecutionBundleCache(
  bundleHashes$: Computed<Promise<readonly string[] | null>>,
) {
  return computed(
    async (get): Promise<ExecutionBundleCacheObservation | null> => {
      const bundleHashes = await get(bundleHashes$);
      if (bundleHashes === null) {
        return null;
      }
      const db = get(rawSqlReadDb$);
      const cache = get(contentBundleUrlCacheContext$);
      const timestamp = nowDate().toISOString();
      const startedAt = monotonicNow();
      const rows = await db.execute(sql`SELECT
        ${contentBundleUrlCacheSnapshotSql(cache, bundleHashes)} AS "cachedBundleUrls"`);
      const [row] = parseRawRows(bundleCacheRowSchema, rows);
      if (!row) {
        throw new Error("Execution bundle cache query returned no row");
      }
      const readyAt = monotonicNow();
      return {
        bundleUrlCache: { context: cache, rows: row.cachedBundleUrls },
        timing: { timestamp, startedAt, readyAt },
      };
    },
  );
}

export const prepareDirectRun$ = command(
  async (
    { set },
    input: AdmittedRunLaunch,
    bundleCache: ExecutionBundleCacheRead,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const { mounts, bundles } = input.packages;
    const [runtime, publication] = await joinAll([
      (async () => {
        const prepared = await set(
          prepareExecutionRuntimeContext$,
          input,
          mounts,
          signal,
        );
        signal.throwIfAborted();
        const readyAt = monotonicNow();
        const networkPolicyInputs = await set(prepareExecutionNetworkPolicy$, {
          connectorRuntimeTargets: prepared.context.connectorRuntimeTargets,
          networkPolicyInputs: prepared.networkPolicyInputs,
        });
        return { prepared, readyAt, networkPolicyInputs };
      })(),
      (async () => {
        const snapshot = await bundleCache;
        signal.throwIfAborted();
        if (!snapshot.ok) {
          throw snapshot.error;
        }
        if (snapshot.value === null) {
          throw new Error(
            "Admitted Run is missing its bundle URL cache snapshot",
          );
        }
        const signed = await set(
          signExecutionContentBundles$,
          bundles,
          snapshot.value.bundleUrlCache,
          signal,
        );
        return { signed, timing: snapshot.value.timing };
      })(),
    ]);
    signal.throwIfAborted();
    const { prepared } = runtime;
    const bundleCacheWaitMs = Math.max(
      0,
      publication.timing.readyAt - runtime.readyAt,
    );
    const { run } = input;
    const context = prepared.context;
    const executionContext = buildExecutionContext({
      run,
      reuseKey: input.reuseKey,
      preparedContext: context,
      networkPolicyInputs: runtime.networkPolicyInputs,
      contentBundles: publication.signed.contentBundles,
    });
    return {
      cachePublication: {
        runId: run.id,
        runnerGroup: input.runnerGroup,
        profile: input.profile,
        cacheWrites: [
          ...prepared.storageCacheWrites,
          ...publication.signed.cacheWrites,
        ],
        bundleCacheRead: {
          startedAt: publication.timing.timestamp,
          durationMs: publication.timing.readyAt - publication.timing.startedAt,
          consumerWaitMs: bundleCacheWaitMs,
        },
      } satisfies DirectRunCachePublication,
      executionContext,
      contextSnapshot: {
        runId: run.id,
        userId: run.userId,
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        vars: run.vars,
        context: {
          ...context,
          networkPolicies: executionContext.networkPolicies,
        },
        secretNames: ["OKOU_TOKEN"],
        secretValues: executionContext.secretValues,
      },
    };
  },
);

/** The pick entry owns this optional publication independently of delivery. */
export const publishDirectRunCache$ = command(
  async ({ set }, args: DirectRunCachePublication, signal: AbortSignal) => {
    const publication = await set(
      persistStoragePresignedUrls$,
      args.cacheWrites,
      signal,
    );
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    const dimensions = {
      runner_group: args.runnerGroup,
      profile: args.profile,
      ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
    };
    recordSandboxOperations([
      {
        sandboxType: "runner",
        actionType: "api_dispatch_bundle_url_cache_read",
        runId: args.runId,
        durationMs: args.bundleCacheRead.durationMs,
        success: true,
        timestamp: args.bundleCacheRead.startedAt,
        dimensions: {
          ...dimensions,
          span_kind: "nested",
          bundle_cache_consumer_wait_ms: args.bundleCacheRead.consumerWaitMs,
        },
      },
      {
        sandboxType: "runner",
        actionType: "api_dispatch_presigned_url_cache_write",
        runId: args.runId,
        durationMs: publication.durationMs,
        success: publication.status !== "error",
        timestamp: nowDate().toISOString(),
        dimensions: {
          ...dimensions,
          span_kind: "background",
          cache_write_status: publication.status,
          cache_entry_count: new Set(
            args.cacheWrites.map((value) => {
              return value.cacheKey;
            }),
          ).size,
        },
      },
    ]);
    return publication;
  },
);
