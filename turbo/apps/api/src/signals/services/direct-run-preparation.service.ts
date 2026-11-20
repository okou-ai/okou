import { chatEvents } from "@okouai/db/schema/chat-event";
import { command } from "ccstate";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { array, boolean, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { monotonicNow, nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import { joinAll } from "../utils";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import { selectExecutionContentBundles } from "./execution-content-bundle";
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
  readonly run: Omit<ExecutionPublicationRun, "isFirstRun">;
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

const executionPublicationFactsSchema = object({
  isFirstRun: boolean(),
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

const readExecutionPublicationFacts$ = command(
  async (
    { get },
    run: AdmittedRunLaunch["run"],
    bundleHashes: readonly string[],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = get(rawSqlReadDb$);
    const cache = get(contentBundleUrlCacheContext$);
    const timestamp = nowDate().toISOString();
    const startedAt = monotonicNow();
    const rows = await db.execute(sql`SELECT
      NOT EXISTS(SELECT 1 FROM ${chatEvents} WHERE ${and(eq(chatEvents.chatThreadId, run.chatThreadId), isNotNull(chatEvents.runId), ne(chatEvents.runId, run.id))}) AS "isFirstRun",
      ${contentBundleUrlCacheSnapshotSql(cache, bundleHashes)} AS "cachedBundleUrls"`);
    signal.throwIfAborted();
    const [row] = parseRawRows(executionPublicationFactsSchema, rows);
    if (!row) {
      throw new Error("Execution publication query returned no row");
    }
    const readyAt = monotonicNow();
    return {
      isFirstRun: row.isFirstRun,
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
    const [runtime, publicationFacts] = await joinAll([
      (async () => {
        const prepared = await set(
          prepareExecutionRuntimeContext$,
          input,
          packageContext,
          signal,
        );
        return { prepared, readyAt: monotonicNow() };
      })(),
      set(readExecutionPublicationFacts$, input.run, bundles.hashes, signal),
    ]);
    signal.throwIfAborted();
    const { prepared } = runtime;
    const bundleCacheWaitMs = Math.max(
      0,
      publicationFacts.timing.readyAt - runtime.readyAt,
    );
    const run = {
      ...input.run,
      isFirstRun: publicationFacts.isFirstRun,
    };
    const context = prepared.context;
    const publication = await set(
      prepareExecutionPublication$,
      {
        run,
        reuseKey: input.reuseKey,
        preparedContext: context,
        networkPolicyInputs: prepared.networkPolicyInputs,
        bundles,
        bundleUrlCache: publicationFacts.bundleUrlCache,
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
          startedAt: publicationFacts.timing.timestamp,
          durationMs:
            publicationFacts.timing.readyAt - publicationFacts.timing.startedAt,
          consumerWaitMs: bundleCacheWaitMs,
        },
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
