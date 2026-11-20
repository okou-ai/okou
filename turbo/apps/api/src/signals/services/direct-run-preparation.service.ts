import { command } from "ccstate";
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
  selectExecutionContentBundles,
  signExecutionContentBundles$,
} from "./execution-content-bundle";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import {
  executionPackages,
  prepareExecutionRuntimeContext$,
} from "./execution-runtime-context";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
} from "./content-bundle-presigned-url-cache";
import {
  buildExecutionContext,
  prepareExecutionNetworkPolicyRefreshes$,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import type { RunnerReusePreparation } from "./runner-reuse-preference";
import {
  persistStoragePresignedUrls$,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** Receipt from durable Thread Run admission. */
export interface AdmittedRunLaunch {
  readonly run: ExecutionPublicationRun;
  readonly memoryMounts: readonly AcceptedMemoryMount[];
  readonly facts: AdmittedExecutionFacts;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly createdAt: Date;
  readonly reusePreparation: RunnerReusePreparation;
}

export interface DirectRunCachePublication {
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

const readExecutionBundleCache$ = command(
  async ({ get }, bundleHashes: readonly string[], signal: AbortSignal) => {
    signal.throwIfAborted();
    const db = get(rawSqlReadDb$);
    const cache = get(contentBundleUrlCacheContext$);
    const timestamp = nowDate().toISOString();
    const startedAt = monotonicNow();
    const rows = await db.execute(sql`SELECT
      ${contentBundleUrlCacheSnapshotSql(cache, bundleHashes)} AS "cachedBundleUrls"`);
    signal.throwIfAborted();
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

export const prepareDirectRun$ = command(
  async ({ set }, input: AdmittedRunLaunch, signal: AbortSignal) => {
    signal.throwIfAborted();
    const packageContext = executionPackages(input);
    const bundles = selectExecutionContentBundles(
      input.facts.executionPackages,
      packageContext,
    );
    const [runtime, publication] = await joinAll([
      (async () => {
        const prepared = await set(
          prepareExecutionRuntimeContext$,
          input,
          packageContext,
          signal,
        );
        signal.throwIfAborted();
        const readyAt = monotonicNow();
        const refreshedPolicies = await set(
          prepareExecutionNetworkPolicyRefreshes$,
          {
            preparedContext: prepared.context,
            networkPolicyInputs: prepared.networkPolicyInputs,
          },
        );
        return { prepared, readyAt, refreshedPolicies };
      })(),
      (async () => {
        const cache = await set(
          readExecutionBundleCache$,
          bundles.hashes,
          signal,
        );
        const signed = await set(
          signExecutionContentBundles$,
          bundles,
          cache.bundleUrlCache,
          signal,
        );
        return { signed, timing: cache.timing };
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
      refreshedPolicies: runtime.refreshedPolicies,
      contentBundles: publication.signed.contentBundles,
    });
    return {
      cachePublication: {
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
  async (
    { set },
    args: DirectRunCachePublication & {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
    },
    signal: AbortSignal,
  ) => {
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
