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
import { agentInstructionsSelectionSql } from "./execution-instructions-selection";
import { createExecutionRuntimeContext } from "./execution-runtime-context";
import { contentBundleAvailableCondition } from "./execution-content-bundle";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
} from "./content-bundle-presigned-url-cache";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  executionContextBody,
  prepareExecutionPublication$,
  withExecutionContentBundles$,
  executionBundleHashes,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import type { RunnerReusePreparation } from "./runner-reuse-preference";
import {
  persistStoragePresignedUrls$,
  type StoragePresignedUrlCacheWrite,
} from "./system-storage-presigned-url-cache.service";
import { recordExecutionPreparationTimings } from "./api-dispatch-timing.service";
import {
  executionWorkflowSchema,
  executionWorkflowInput,
  executionWorkflowSelectionSql,
} from "./execution-workflow-selection";

/** Receipt from durable Thread Run admission, before first-run classification. */
export interface AdmittedRunLaunch {
  readonly run: Omit<ExecutionPublicationRun, "isFirstRun">;
  readonly facts: AdmittedExecutionFacts;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string;
  readonly createdAt: Date;
  readonly reusePreparation: RunnerReusePreparation;
}

const packageSelectionSchema = object({
  available: boolean(),
  isFirstRun: boolean(),
  workflows: array(executionWorkflowSchema),
  instructionsBundle: contentBundleSchema.nullable(),
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
    const selection = executionWorkflowInput(packageContext);
    const cache = get(contentBundleUrlCacheContext$);
    // Read the admitted identity and its authorized packages in one snapshot.
    const rows = await db.execute(sql`WITH admitted_run AS MATERIALIZED (
      SELECT ${agentRuns.id} AS "id",${agentRuns.chatThreadId} AS "chatThreadId",${agentRuns.agentId} AS "agentId",
        ${agentRuns.userId} AS "userId",${agentRuns.orgId} AS "orgId",${agentRuns.triggerSource} AS "triggerSource",${agentRuns.workflowAutomationId} AS "workflowAutomationId"
      FROM ${agentRuns} WHERE ${and(eq(agentRuns.id, input.run.id), eq(agentRuns.userId, input.run.userId), eq(agentRuns.orgId, input.run.orgId), eq(agentRuns.status, "pending"))}
    ), ${agentInstructionsSelectionSql(sql`${input.facts.featureFlags[FeatureSwitchKey.SingleAgent]}`)},
      ${executionWorkflowSelectionSql(selection)}
    SELECT EXISTS(SELECT 1 FROM workflow_admission)
      AND COALESCE((SELECT "bundlesAvailable" FROM workflow_selection),false)
      AND NOT EXISTS(SELECT 1 FROM selected_agent WHERE NOT ${contentBundleAvailableCondition(sql`selected_agent."instructionsBundle"`)}) AS available,
      NOT EXISTS(SELECT 1 FROM ${chatEvents} WHERE ${and(eq(chatEvents.chatThreadId, input.run.chatThreadId), isNotNull(chatEvents.runId), ne(chatEvents.runId, input.run.id))}) AS "isFirstRun",
      (SELECT documents FROM workflow_selection) AS workflows,
      (SELECT "instructionsBundle" FROM selected_agent) AS "instructionsBundle",
      ${contentBundleUrlCacheSnapshotSql(cache, executionBundleHashes(packageContext))} AS "cachedBundleUrls"`);
    const [row] = parseRawRows(packageSelectionSchema, rows);
    if (!row?.available) {
      throw new Error(
        "Admitted Run packages or source authorization are unavailable",
      );
    }
    return { row, selection, cache };
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
    const context = {
      ...prepared.context,
      encryptedSecrets: await set(
        encryptExecutionSecrets$,
        prepared.secrets,
        signal,
      ),
    };
    const response = await set(
      prepareExecutionPublication$,
      {
        preparedContext: context,
        networkPolicyInputs: prepared.networkPolicyInputs,
      },
      signal,
    );
    const publication = await set(
      withExecutionContentBundles$,
      {
        executionContext: executionContextBody({
          run,
          reuseKey: input.reuseKey,
          preparedContext: context,
          ...response,
        }),
        packages: packages.row,
        workflowInput: packages.selection,
        officialWorkflowBundles: context.officialWorkflowBundles,
        seedSkillBundles: context.seedSkillBundles,
        templateGuidanceBundles: context.templateGuidanceBundles,
        bundleUrlCache: packages.cache,
      },
      signal,
    );
    signal.throwIfAborted();
    recordExecutionPreparationTimings({
      runId: input.run.id,
      runnerGroup: input.runnerGroup,
      profile: input.profile,
      records: prepared.connectorOperationTimings,
    });
    return {
      cacheWrites: [...prepared.storageCacheWrites, ...publication.cacheWrites],
      executionContext: publication.executionContext,
      sourceAuthorization: {
        workflows: packages.selection,
        workflowIds: packages.row.workflows.map((workflow) => {
          return workflow.id;
        }),
        singleAgent: input.facts.featureFlags[FeatureSwitchKey.SingleAgent],
      },
      contextSnapshot: {
        runId: run.id,
        userId: run.userId,
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        context: {
          ...context,
          networkPolicies: response.refreshedPolicies.networkPolicies,
        },
        secretNames: Object.keys(prepared.secrets ?? {}),
        secretValues: response.secretValues,
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
