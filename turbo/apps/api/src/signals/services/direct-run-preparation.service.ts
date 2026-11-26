import { command, computed, type Computed } from "ccstate";
import { sql } from "drizzle-orm";
import { array, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { monotonicNow, nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { joinAll } from "../utils";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import {
  type selectExecutionContentBundles,
  signExecutionContentBundles$,
} from "./execution-content-bundle";
import {
  prepareExecutionRuntimeContext$,
  type ExecutionRuntimeResources,
} from "./execution-runtime-context";
import type { ExecutionPackageMounts } from "./execution-workflow-selection";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
  type PrefetchedContentBundleUrls,
  type ContentBundleUrlCacheSnapshot,
} from "./content-bundle-presigned-url-cache";
import {
  buildExecutionContext,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import {
  persistStoragePresignedUrls$,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** Inputs captured by the picker before durable Run admission. */
export interface DirectRunInput {
  readonly run: Omit<ExecutionPublicationRun, "isFirstRun">;
  readonly facts: AdmittedExecutionFacts;
  readonly packageMounts: ExecutionPackageMounts;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly predecessorRunId: string | null;
  readonly antigravityEnabled: boolean;
}

/** Receipt from durable Thread Run admission. */
export interface AdmittedRunLaunch extends DirectRunInput {
  readonly run: ExecutionPublicationRun;
  readonly createdAt: Date;
}

export interface ExecutionBundleCacheObservation {
  readonly bundles: ReturnType<typeof selectExecutionContentBundles>;
  readonly bundleUrlCache: ContentBundleUrlCacheSnapshot;
  readonly timing: {
    readonly timestamp: string;
    readonly startedAt: number;
    readonly readyAt: number;
  };
}

interface PreparedExecutionBundleUrls {
  readonly signed: Awaited<
    ReturnType<(typeof signExecutionContentBundles$)["write"]>
  >;
  readonly timing: ExecutionBundleCacheObservation["timing"];
}

export type ExecutionBundleUrlsRead =
  Promise<PreparedExecutionBundleUrls | null>;

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
  bundles$: Computed<
    Promise<{
      readonly bundles: ExecutionBundleCacheObservation["bundles"];
      readonly prefetchedUrls: PrefetchedContentBundleUrls | null;
    } | null>
  >,
) {
  return computed(
    async (get): Promise<ExecutionBundleCacheObservation | null> => {
      const input = await get(bundles$);
      if (input === null) {
        return null;
      }
      const { bundles, prefetchedUrls } = input;
      const cache = get(contentBundleUrlCacheContext$);
      // A covered hash with no cached URL is already known to require signing.
      const covered = new Set(prefetchedUrls?.hashes);
      const remaining = bundles.hashes.filter((hash) => {
        return !covered.has(hash);
      });
      const timestamp = nowDate().toISOString();
      const startedAt = monotonicNow();
      if (remaining.length === 0) {
        return {
          bundles,
          bundleUrlCache: { context: cache, rows: prefetchedUrls?.rows ?? [] },
          timing: { timestamp, startedAt, readyAt: startedAt },
        };
      }
      const db = get(rawSqlReadDb$);
      const rows = await db.execute(sql`SELECT
        ${contentBundleUrlCacheSnapshotSql(cache, remaining)} AS "cachedBundleUrls"`);
      const [row] = parseRawRows(bundleCacheRowSchema, rows);
      if (!row) {
        throw new Error("Execution bundle cache query returned no row");
      }
      const readyAt = monotonicNow();
      return {
        bundles,
        bundleUrlCache: {
          context: cache,
          rows: [...(prefetchedUrls?.rows ?? []), ...row.cachedBundleUrls],
        },
        timing: { timestamp, startedAt, readyAt },
      };
    },
  );
}

export const prepareExecutionBundleUrls$ = command(
  async (
    { set },
    source: Promise<ExecutionBundleCacheObservation | null>,
    signal: AbortSignal,
  ): ExecutionBundleUrlsRead => {
    const snapshot = await source;
    signal.throwIfAborted();
    if (snapshot === null) {
      return null;
    }
    const signed = await set(
      signExecutionContentBundles$,
      snapshot.bundles,
      snapshot.bundleUrlCache,
      signal,
    );
    signal.throwIfAborted();
    return { signed, timing: snapshot.timing };
  },
);

export interface PreparedDirectRunContext {
  readonly prepared: Awaited<
    ReturnType<(typeof prepareExecutionRuntimeContext$)["write"]>
  >;
  readonly publication: PreparedExecutionBundleUrls;
}

export const prepareDirectRunContext$ = command(
  async (
    { set },
    input: DirectRunInput,
    bundleUrls: ExecutionBundleUrlsRead,
    resources: ExecutionRuntimeResources,
    signal: AbortSignal,
  ): Promise<PreparedDirectRunContext> => {
    signal.throwIfAborted();
    const [prepared, publication] = await joinAll([
      set(
        prepareExecutionRuntimeContext$,
        input,
        input.packageMounts,
        resources,
        signal,
      ),
      bundleUrls,
    ]);
    signal.throwIfAborted();
    if (publication === null) {
      throw new Error("Run is missing its prepared Bundle URLs");
    }
    return { prepared, publication };
  },
);

export function completeDirectRunPreparation(
  input: AdmittedRunLaunch,
  {
    prepared,
    publication,
  }: Awaited<ReturnType<(typeof prepareDirectRunContext$)["write"]>>,
) {
  const bundleCacheWaitMs = Math.max(
    0,
    publication.timing.readyAt - prepared.readyAt,
  );
  const { run } = input;
  const context = prepared.context;
  const executionContext = buildExecutionContext({
    run,
    reuseKey: input.reuseKey,
    preparedContext: context,
    networkPolicyInputs: prepared.networkPolicyInputs,
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
}

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
