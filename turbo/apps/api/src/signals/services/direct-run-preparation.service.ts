import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import type { ExecutionInput } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { array, boolean, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { rawSqlReadDb$ } from "../external/db";
import { agentInstructionsSelectionSql } from "./execution-instructions-selection";
import { createExecutionContext } from "./execution-context";
import { contentBundleAvailableCondition } from "./execution-content-bundle";
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
import { persistStoragePresignedUrls$ } from "./system-storage-presigned-url-cache.service";
import { recordExecutionPreparationTimings } from "./api-dispatch-timing.service";
import {
  executionWorkflowSchema,
  executionWorkflowInput,
  executionWorkflowSelectionSql,
} from "./execution-workflow-selection";

/** Retained result of this graph's own durable admission, never a stored payload. */
export interface AdmittedRunLaunch {
  readonly run: ExecutionPublicationRun;
  readonly executionContext: ExecutionInput;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly createdAt: Date;
  readonly reusePreparation: RunnerReusePreparation | undefined;
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
  const executionInput$ = computed(async (get) => {
    const input = await get(input$);
    return { run: input.run, context: input.executionContext };
  });
  const prepared$ = createExecutionContext(executionInput$);
  const packages$ = computed(async (get) => {
    const [input, prepared] = await Promise.all([get(input$), get(prepared$)]);
    const db = get(rawSqlReadDb$);
    const selection = executionWorkflowInput(prepared.context);
    const cache = get(contentBundleUrlCacheContext$);
    // Read the admitted identity and its authorized packages in one snapshot.
    const rows = await db.execute(sql`WITH admitted_run AS MATERIALIZED (
      SELECT ${agentRuns.id} AS "id",${agentRuns.chatThreadId} AS "chatThreadId",${agentRuns.agentId} AS "agentId",
        ${agentRuns.userId} AS "userId",${agentRuns.orgId} AS "orgId",${agentRuns.triggerSource} AS "triggerSource",${agentRuns.workflowAutomationId} AS "workflowAutomationId"
      FROM ${agentRuns} WHERE ${and(eq(agentRuns.id, input.run.id), eq(agentRuns.userId, input.run.userId), eq(agentRuns.orgId, input.run.orgId), eq(agentRuns.status, "pending"))}
    ), ${agentInstructionsSelectionSql(sql`${input.executionContext.featureFlags?.singleAgent === true}`)},
      ${executionWorkflowSelectionSql(selection)}
    SELECT EXISTS(SELECT 1 FROM workflow_admission)
      AND COALESCE((SELECT "bundlesAvailable" FROM workflow_selection),false)
      AND NOT EXISTS(SELECT 1 FROM selected_agent WHERE NOT ${contentBundleAvailableCondition(sql`selected_agent."instructionsBundle"`)}) AS available,
      NOT EXISTS(SELECT 1 FROM ${chatEvents} WHERE ${input.run.chatThreadId === null ? sql`false` : and(eq(chatEvents.chatThreadId, input.run.chatThreadId), isNotNull(chatEvents.runId), ne(chatEvents.runId, input.run.id))}) AS "isFirstRun",
      (SELECT documents FROM workflow_selection) AS workflows,
      (SELECT "instructionsBundle" FROM selected_agent) AS "instructionsBundle",
      ${contentBundleUrlCacheSnapshotSql(cache, executionBundleHashes(prepared.context))} AS "cachedBundleUrls"`);
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
      isFirstRun:
        input.run.chatThreadId === null ? null : packages.row.isFirstRun,
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
        run,
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
    await set(
      persistStoragePresignedUrls$,
      [...prepared.storageCacheWrites, ...publication.cacheWrites],
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
      executionContext: publication.executionContext,
      sourceAuthorization: {
        workflows: packages.selection,
        workflowIds: packages.row.workflows.map((workflow) => {
          return workflow.id;
        }),
        singleAgent: context.featureFlags?.singleAgent === true,
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
