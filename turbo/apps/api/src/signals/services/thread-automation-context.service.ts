import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { workflows } from "@okouai/db/schema/workflow";
import { computed, type Computed } from "ccstate";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
  zodDriverValueDecoder,
} from "../../lib/db-structured-result";
import { db$ } from "../external/db";
import type { AgentRunContextSignals } from "./agent-run-context.signals";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import {
  executionPackageSourcesSchema,
  executionPackageSourcesSql,
  type ExecutionPackageSources,
} from "./execution-package-sources";
import { resolveOrdinaryAutomationWorkflowName } from "./execution-workflow-selection";
import type { PickedThreadInputEvent } from "./thread-run-prompt/types";
import { restoredWorkflowAutomationEventPayload } from "./workflow-automation-context.service";

const launchAutomationColumns = Object.freeze({
  id: workflowAutomations.id,
  orgId: workflowAutomations.orgId,
  workflowId: workflowAutomations.workflowId,
  ownerUserId: workflowAutomations.ownerUserId,
  kind: workflowAutomations.kind,
  scheduleType: workflowAutomations.scheduleType,
  cronExpression: workflowAutomations.cronExpression,
  timezone: workflowAutomations.timezone,
  enabled: workflowAutomations.enabled,
  autonomyBudget: workflowAutomations.autonomyBudget,
  officialBlueprintKey: workflowAutomations.officialBlueprintKey,
});

export interface ThreadAutomationTarget {
  readonly automation: Pick<
    typeof workflowAutomations.$inferSelect,
    keyof typeof launchAutomationColumns
  >;
  readonly packageSources: ExecutionPackageSources;
  /** Authorized ordinary package winner for this picked Automation. */
  readonly ordinaryWorkflowName: string | null;
  readonly workflow: Pick<
    typeof workflows.$inferSelect,
    | "id"
    | "orgId"
    | "name"
    | "ownerUserId"
    | "visibility"
    | "officialDefinitionName"
  >;
}

interface ThreadAutomationSnapshot {
  readonly event: Pick<
    typeof chatAutomationContext.$inferSelect,
    | "id"
    | "chatThreadId"
    | "automationId"
    | "triggerBrief"
    | "workflowName"
    | "eventType"
    | "eventPayload"
  >;
  readonly target: ThreadAutomationTarget | null;
  readonly sourceRunIdType: string | null;
  readonly sourceAutonomyBudget: number | null;
}

export function createThreadAutomationSnapshot(
  pickedEvent$: Computed<Promise<PickedThreadInputEvent | null>>,
  bootstrap: AgentRunContextSignals,
  dispatchTiming$: Computed<ApiDispatchTimingCollector>,
): Computed<Promise<ThreadAutomationSnapshot | null>> {
  return computed(async (get) => {
    const pickedEvent = await get(pickedEvent$);
    if (
      pickedEvent?.contextType !== "automation" ||
      pickedEvent.contextId === null
    ) {
      return null;
    }
    const sourceRun = sql`CASE ${chatAutomationContext.eventType}
      WHEN 'chat-run-finished' THEN ${chatAutomationContext.eventPayload} -> 'runId'
      WHEN 'manual' THEN ${chatAutomationContext.eventPayload} -> 'sourceRunId'
    END`;
    // A missing ID and an explicit non-string value have different delegation rules.
    const sourceRunIdType = sql`jsonb_typeof(${sourceRun})`.mapWith(
      nullableDriverValueDecoder(pgTextDecoder),
    );
    const sourceRunId = sql`(${sourceRun}) #>> '{}'`;
    const query = get(db$)
      .select({
        event: {
          id: chatAutomationContext.id,
          chatThreadId: chatAutomationContext.chatThreadId,
          automationId: chatAutomationContext.automationId,
          triggerBrief: chatAutomationContext.triggerBrief,
          workflowName: chatAutomationContext.workflowName,
          eventType: chatAutomationContext.eventType,
          eventPayload: chatAutomationContext.eventPayload,
        },
        sourceRunIdType,
        sourceAutonomyBudget: agentRuns.autonomyBudget,
        automation: launchAutomationColumns,
        packageSources: sql`CASE WHEN ${workflows.id} IS NOT NULL
          THEN ${executionPackageSourcesSql(bootstrap)}
        END`.mapWith(
          zodDriverValueDecoder(executionPackageSourcesSchema.nullable()),
        ),
        workflow: {
          id: workflows.id,
          orgId: workflows.orgId,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
          officialDefinitionName: workflows.officialDefinitionName,
        },
      })
      .from(chatAutomationContext)
      .leftJoin(
        workflowAutomations,
        eq(workflowAutomations.id, chatAutomationContext.automationId),
      )
      .leftJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .leftJoin(
        agentRuns,
        and(
          eq(
            agentRuns.id,
            sql`CASE
            WHEN ${sourceRunIdType} = 'string' AND pg_input_is_valid(${sourceRunId}, 'uuid')
            THEN (${sourceRunId})::uuid
          END`,
          ),
          isNotNull(agentRuns.triggerSource),
        ),
      )
      .where(
        and(
          eq(chatAutomationContext.id, pickedEvent.contextId),
          eq(chatAutomationContext.chatThreadId, pickedEvent.chatThreadId),
        ),
      );
    const [row] = await get(dispatchTiming$).measure(
      "api_dispatch_prepare_execution_package_sources",
      "nested",
      () => {
        return query;
      },
    );
    if (!row) {
      return null;
    }
    const { event, automation, workflow, packageSources } = row;
    return {
      event,
      target:
        automation && workflow && packageSources
          ? {
              automation,
              workflow,
              packageSources,
              ordinaryWorkflowName: resolveOrdinaryAutomationWorkflowName(
                { automation, workflow },
                bootstrap,
                packageSources,
              ),
            }
          : null,
      sourceRunIdType: row.sourceRunIdType,
      sourceAutonomyBudget: row.sourceAutonomyBudget,
    };
  });
}

export function createThreadAutomationPayload(
  snapshot$: ReturnType<typeof createThreadAutomationSnapshot>,
) {
  return computed(async (get) => {
    const snapshot = await get(snapshot$);
    const payload = snapshot?.event.eventPayload;
    return payload ? restoredWorkflowAutomationEventPayload(payload) : null;
  });
}
