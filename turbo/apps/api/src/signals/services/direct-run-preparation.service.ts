import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { array, boolean, object } from "zod";
import { normalizeBuildCommitSha } from "../../lib/build-info";
import { parseRawRows } from "../../lib/db-raw-rows";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { rawSqlReadDb$ } from "../external/db";
import { recordSandboxOperations } from "../external/sandbox-op-log";
import type { AdmittedExecutionFacts } from "./admitted-execution-facts";
import type { AcceptedMemoryMount } from "./execution-storage.service";
import { agentInstructionsSelectionSql } from "./execution-instructions-selection";
import { createExecutionRuntimeContext } from "./execution-runtime-context";
import { contentBundleAvailableCondition } from "./execution-content-bundle";
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
import {
  executionWorkflowSchema,
  assertOfficialWorkflowMounts,
  executionSkillRoot,
  executionWorkflowSelectionSql,
  type ExecutionWorkflowInput,
} from "./execution-workflow-selection";

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

const capturedPackagesSchema = object({
  workflows: array(executionWorkflowSchema),
  instructionsBundle: contentBundleSchema.nullable(),
});

export type CapturedExecutionPackages = ReturnType<
  typeof capturedPackagesSchema.parse
>;

/** Read authorized package descriptors from a single snapshot of the picked Run's sources. */
export const captureExecutionPackages$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly singleAgent: boolean;
      readonly selection: ExecutionWorkflowInput;
    },
    signal: AbortSignal,
  ): Promise<CapturedExecutionPackages | null> => {
    signal.throwIfAborted();
    const { selection } = args;
    const db = get(rawSqlReadDb$);
    const rows = await db.execute(sql`WITH admitted_run AS MATERIALIZED (
      SELECT ${args.orgId}::text AS "orgId", ${args.userId}::text AS "userId",
        ${selection.selection.agentId}::uuid AS "agentId",
        ${selection.selection.automationId ?? null}::uuid AS "workflowAutomationId"
    ), ${agentInstructionsSelectionSql(sql`${args.singleAgent}`)},
      ${executionWorkflowSelectionSql(selection)}
    SELECT documents AS workflows,
      (SELECT "instructionsBundle" FROM selected_agent) AS "instructionsBundle"
    FROM workflow_admission
    WHERE "bundlesAvailable"
      AND NOT EXISTS(SELECT 1 FROM selected_agent WHERE NOT ${contentBundleAvailableCondition(sql`selected_agent."instructionsBundle"`)})`);
    signal.throwIfAborted();
    const [packages] = parseRawRows(capturedPackagesSchema, rows);
    return packages ?? null;
  },
);

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
    const skillRoot = executionSkillRoot(packageContext.cliAgentType);
    assertOfficialWorkflowMounts(
      packageContext.officialWorkflowBundles,
      packageContext.storageMounts,
      skillRoot,
    );
    const cache = get(contentBundleUrlCacheContext$);
    const { instructionsBundle, workflows } = input.facts.executionPackages;
    const bundleHashes = [
      ...(instructionsBundle ? [instructionsBundle.sha256] : []),
      ...workflows.map((workflow) => {
        return workflow.contentBundle.sha256;
      }),
      ...executionBundleHashes(packageContext),
    ];
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
    return {
      row: { ...input.facts.executionPackages, ...row },
      skillRoot,
      cache,
    };
  });
  return computed(async (get) => {
    const [input, prepared, packages] = await Promise.all([
      get(input$),
      get(prepared$),
      get(packages$),
    ]);
    return { input, prepared, packages };
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
    { input, prepared, packages }: DirectRunPreparationInput,
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
      cacheWrites: [...prepared.storageCacheWrites, ...publication.cacheWrites],
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
    args: {
      readonly runId: string;
      readonly runnerGroup: string;
      readonly profile: string;
      readonly cacheWrites: readonly StoragePresignedUrlCacheWrite[];
    },
    signal: AbortSignal,
  ) => {
    const publication = await set(
      persistStoragePresignedUrls$,
      args.cacheWrites,
      signal,
    );
    const apiCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
    recordSandboxOperations([
      {
        sandboxType: "runner",
        actionType: "api_dispatch_presigned_url_cache_write",
        runId: args.runId,
        durationMs: publication.durationMs,
        success: publication.status !== "error",
        timestamp: nowDate().toISOString(),
        dimensions: {
          span_kind: "background",
          cache_write_status: publication.status,
          cache_entry_count: new Set(
            args.cacheWrites.map((value) => {
              return value.cacheKey;
            }),
          ).size,
          runner_group: args.runnerGroup,
          profile: args.profile,
          ...(apiCommitSha ? { api_commit_sha: apiCommitSha } : {}),
        },
      },
    ]);
    return publication;
  },
);
