import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { array, boolean, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { monotonicNow, nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import { createExecutionRuntimeContext } from "./execution-runtime-context";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
} from "./content-bundle-presigned-url-cache";
import {
  prepareExecutionPublication$,
  executionBundleHashes,
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
  pending: boolean(),
  isFirstRun: boolean(),
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

/** Constructed before admission commands run; all execution reads depend on their result. */
export function createDirectRunPreparation(
  input$: Computed<Promise<AdmittedRunLaunch>>,
) {
  const { prepared$, packageContext$ } = createExecutionRuntimeContext(input$);
  const packages$ = computed(async (get) => {
    const [input, packageContext] = await Promise.all([
      get(input$),
      get(packageContext$),
    ]);
    const db = get(rawSqlReadDb$);
    const cache = get(contentBundleUrlCacheContext$);
    const { instructionsBundle, workflows } = input.facts.executionPackages;
    const bundleHashes = [
      instructionsBundle.sha256,
      ...workflows.map((workflow) => {
        return workflow.contentBundle.sha256;
      }),
      ...executionBundleHashes(packageContext),
    ];
    const timestamp = nowDate().toISOString();
    const startedAt = monotonicNow();
    const rows = await db.execute(sql`SELECT EXISTS(
      SELECT 1 FROM ${agentRuns}
      WHERE ${and(eq(agentRuns.id, input.run.id), eq(agentRuns.userId, input.run.userId), eq(agentRuns.orgId, input.run.orgId), eq(agentRuns.status, "pending"))}
    ) AS pending,
      NOT EXISTS(SELECT 1 FROM ${chatEvents} WHERE ${and(eq(chatEvents.chatThreadId, input.run.chatThreadId), isNotNull(chatEvents.runId), ne(chatEvents.runId, input.run.id))}) AS "isFirstRun",
      ${contentBundleUrlCacheSnapshotSql(cache, bundleHashes)} AS "cachedBundleUrls"`);
    const [row] = parseRawRows(executionPublicationFactsSchema, rows);
    if (!row?.pending) {
      throw new Error("Run is no longer pending for execution publication");
    }
    const readyAt = monotonicNow();
    return {
      row: { ...input.facts.executionPackages, ...row },
      skillRoot: packageContext.skillRoot,
      cache,
      timing: { timestamp, startedAt, readyAt },
    };
  });
  return computed(async (get) => {
    const [input, context, packages] = await Promise.all([
      get(input$),
      (async () => {
        const prepared = await get(prepared$);
        return { prepared, readyAt: monotonicNow() };
      })(),
      get(packages$),
    ]);
    return {
      input,
      prepared: context.prepared,
      packages,
      bundleCacheWaitMs: Math.max(0, packages.timing.readyAt - context.readyAt),
    };
  });
}

type PreparationInput<T> =
  T extends Computed<Promise<infer Value>> ? Value : never;
type DirectRunPreparationInput = PreparationInput<
  ReturnType<typeof createDirectRunPreparation>
>;

export const prepareDirectRun$ = command(
  async (
    { set },
    { input, prepared, packages, bundleCacheWaitMs }: DirectRunPreparationInput,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const run = {
      ...input.run,
      isFirstRun: packages.row.isFirstRun,
    };
    const context = prepared.context;
    const publication = await set(
      prepareExecutionPublication$,
      {
        run,
        reuseKey: input.reuseKey,
        preparedContext: context,
        networkPolicyInputs: prepared.networkPolicyInputs,
        packages: packages.row,
        skillRoot: packages.skillRoot,
        bundleUrlCache: packages.cache,
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
          startedAt: packages.timing.timestamp,
          durationMs: packages.timing.readyAt - packages.timing.startedAt,
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
