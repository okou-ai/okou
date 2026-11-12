import { contentBundleSchema } from "@okouai/api-contracts/contracts/content-bundle";
import {
  preparedExecutionContextSchema,
  type StoredExecutionContext,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { command, computed, type Computed } from "ccstate";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { array, boolean, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { rawSqlReadDb$ } from "../external/db";
import { agentInstructionsSelectionSql } from "./agent-instructions-claim.service";
import { createClaimExecutionContext } from "./claim-execution-context";
import { contentBundleAvailableCondition } from "./content-bundle-claim";
import {
  cachedContentBundleUrlSchema,
  contentBundleUrlCacheContext$,
  contentBundleUrlCacheSnapshotSql,
} from "./content-bundle-presigned-url-cache";
import { encryptExecutionSecrets$ } from "./execution-secrets.service";
import {
  executionResponseBody,
  prepareExecutionResponse$,
  withExecutionContentBundles$,
  executionBundleHashes,
  type ExecutionPublicationRun,
} from "./run-execution-publication.service";
import type { RunnerReusePreparation } from "./runner-reuse-preference";
import { persistStoragePresignedUrls$ } from "./system-storage-presigned-url-cache.service";
import { recordExecutionPreparationTimings } from "./api-dispatch-timing.service";
import {
  claimedWorkflowSchema,
  workflowClaimInput,
  workflowClaimSelectionSql,
} from "./workflow-claim.service";

/** Retained result of this graph's own durable admission, never a stored payload. */
export interface AdmittedRunLaunch {
  readonly run: ExecutionPublicationRun;
  readonly executionContext: StoredExecutionContext;
  readonly runnerGroup: string;
  readonly profile: string;
  readonly reuseKey: string | null;
  readonly cliAgentSessionId: string | null;
  readonly createdAt: Date;
  readonly apiStartTime: number;
  readonly reusePreparation: RunnerReusePreparation | undefined;
}

const packageSelectionSchema = object({
  available: boolean(),
  isFirstRun: boolean(),
  workflows: array(claimedWorkflowSchema),
  instructionsBundle: contentBundleSchema.nullable(),
  cachedBundleUrls: array(cachedContentBundleUrlSchema),
});

/** Constructed before admission commands run; all execution reads depend on their result. */
export function createDirectRunPreparation(
  input$: Computed<Promise<AdmittedRunLaunch>>,
) {
  const executionInput$ = computed(async (get) => {
    const input = await get(input$);
    return { run: input.run, executionContext: input.executionContext };
  });
  const materialized$ = createClaimExecutionContext(executionInput$);
  const prepared$ = computed(async (get) => {
    const materialized = await get(materialized$);
    if (materialized.status === "unavailable") {
      throw new Error("Admitted Run execution sources are unavailable");
    }
    if (!materialized.result.success) {
      throw new Error("Admitted Run execution input is invalid");
    }
    return {
      materialized,
      context: preparedExecutionContextSchema.parse(materialized.result.data),
    };
  });
  const packages$ = computed(async (get) => {
    const [input, prepared] = await Promise.all([get(input$), get(prepared$)]);
    const db = get(rawSqlReadDb$);
    const selection = workflowClaimInput(prepared.context);
    const cache = get(contentBundleUrlCacheContext$);
    // These aliases are the shared authorization-selection SQL contract; this
    // is an ordinary source read and acquires no explicit Run/queue lock.
    const rows = await db.execute(sql`WITH locked_run AS MATERIALIZED (
      SELECT ${agentRuns.id} AS "id",${agentRuns.chatThreadId} AS "chatThreadId",${agentRuns.agentId} AS "agentId",
        ${agentRuns.userId} AS "userId",${agentRuns.orgId} AS "orgId",${agentRuns.triggerSource} AS "triggerSource",${agentRuns.workflowAutomationId} AS "workflowAutomationId"
      FROM ${agentRuns} WHERE ${and(eq(agentRuns.id, input.run.id), eq(agentRuns.userId, input.run.userId), eq(agentRuns.orgId, input.run.orgId), eq(agentRuns.status, "pending"))}
    ), ${agentInstructionsSelectionSql(sql`${input.executionContext.featureFlags?.singleAgent === true}`)},
      ${workflowClaimSelectionSql(selection)}
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
        prepared.materialized.secrets,
        signal,
      ),
    };
    const response = await set(
      prepareExecutionResponse$,
      {
        run,
        storedContext: context,
        networkPolicyInputs: prepared.materialized.networkPolicyInputs,
      },
      signal,
    );
    const publication = await set(
      withExecutionContentBundles$,
      {
        responseBody: executionResponseBody({
          run,
          reuseKey: input.reuseKey,
          storedContext: context,
          ...response,
        }),
        claim: packages.row,
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
      [...prepared.materialized.storageCacheWrites, ...publication.cacheWrites],
      signal,
    );
    signal.throwIfAborted();
    recordExecutionPreparationTimings({
      runId: input.run.id,
      runnerGroup: input.runnerGroup,
      profile: input.profile,
      records: prepared.materialized.connectorOperationTimings,
      phase: "dispatch",
    });
    return {
      executionContext: publication.responseBody,
      contextSnapshot: {
        runId: run.id,
        userId: run.userId,
        prompt: run.prompt,
        appendSystemPrompt: run.appendSystemPrompt,
        context: {
          ...context,
          networkPolicies: response.refreshedPolicies.networkPolicies,
        },
        secretNames: Object.keys(prepared.materialized.secrets ?? {}),
        secretValues: response.secretValues,
      },
    };
  },
);
