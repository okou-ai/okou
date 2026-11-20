import { command } from "ccstate";
import { sql } from "drizzle-orm";
import { array, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { monotonicNow, nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { joinAll, type Settled } from "../utils";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import {
  type executionPackages,
  prepareExecutionRuntimeContext$,
} from "./execution-runtime-context";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
} from "./content-bundle-presigned-url-cache";
import {
  prepareExecutionPublication$,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import type { RunnerReusePreparation } from "./runner-reuse-preference";
import {
  persistStoragePresignedUrls$,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";

/** Receipt from durable Thread Run admission, before first-run classification. */
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
  readonly bundleSigning: {
    readonly bundleCount: number;
    readonly missCount: number;
    readonly durationMs: number;
  };
}

const bundleUrlSnapshotSchema = object({
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

type ExecutionPackages = ReturnType<typeof executionPackages>;

export const readExecutionBundleUrls$ = command(
  async ({ get }, packages: ExecutionPackages, signal: AbortSignal) => {
    signal.throwIfAborted();
    const db = get(rawSqlReadDb$);
    const cache = get(contentBundleUrlCacheContext$);
    const bundleHashes = [
      packages.instructionsBundle.sha256,
      ...packages.workflows.map((workflow) => {
        return workflow.contentBundle.sha256;
      }),
      ...[
        ...packages.officialWorkflowBundles,
        ...packages.seedSkillBundles,
        ...packages.templateGuidanceBundles,
      ].map(({ sha256 }) => {
        return sha256;
      }),
    ];
    const timestamp = nowDate().toISOString();
    const startedAt = monotonicNow();
    const rows = await db.execute(
      sql`SELECT ${contentBundleUrlCacheSnapshotSql(cache, bundleHashes)} AS "cachedBundleUrls"`,
    );
    signal.throwIfAborted();
    const [row] = parseRawRows(bundleUrlSnapshotSchema, rows);
    if (!row) {
      throw new Error("Execution bundle URL query returned no row");
    }
    const readyAt = monotonicNow();
    return {
      cachedBundleUrls: row.cachedBundleUrls,
      cache,
      timing: { timestamp, startedAt, readyAt },
    };
  },
);

export interface PrefetchedExecutionBundles {
  readonly packages: ExecutionPackages;
  readonly urls: Promise<
    Settled<Awaited<ReturnType<typeof readExecutionBundleUrls$.write>>>
  >;
}

export const prepareDirectRun$ = command(
  async (
    { set },
    input: AdmittedRunLaunch,
    bundles: PrefetchedExecutionBundles,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const [runtime, urls] = await joinAll([
      (async () => {
        const prepared = await set(
          prepareExecutionRuntimeContext$,
          input,
          bundles.packages,
          signal,
        );
        return { prepared, readyAt: monotonicNow() };
      })(),
      bundles.urls,
    ]);
    signal.throwIfAborted();
    if (!urls.ok) {
      throw urls.error;
    }
    const { cache, cachedBundleUrls, timing } = urls.value;
    const { prepared } = runtime;
    const bundleCacheWaitMs = Math.max(0, timing.readyAt - runtime.readyAt);
    const run = input.run;
    const context = prepared.context;
    const publication = await set(
      prepareExecutionPublication$,
      {
        run,
        reuseKey: input.reuseKey,
        preparedContext: context,
        networkPolicyInputs: prepared.networkPolicyInputs,
        packages: { ...bundles.packages, cachedBundleUrls },
        bundleUrlCache: cache,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      cachePublication: {
        cacheWrites: [
          ...prepared.storageCacheWrites,
          ...publication.cacheWrites,
        ],
        bundleCacheRead: {
          startedAt: timing.timestamp,
          durationMs: timing.readyAt - timing.startedAt,
          consumerWaitMs: bundleCacheWaitMs,
        },
        bundleSigning: publication.bundleSigning,
      } satisfies DirectRunCachePublication,
      executionContext: publication.executionContext,
      contextSnapshot: {
        runId: run.id,
        userId: run.userId,
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        vars: run.vars,
        context: {
          ...context,
          networkPolicies: publication.executionContext.networkPolicies,
        },
        secretNames: ["OKOU_TOKEN"],
        secretValues: publication.executionContext.secretValues,
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
          bundle_count: args.bundleSigning.bundleCount,
          bundle_cache_miss_count: args.bundleSigning.missCount,
          bundle_signing_ms: args.bundleSigning.durationMs,
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
