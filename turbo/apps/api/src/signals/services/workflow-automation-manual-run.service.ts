import { command } from "ccstate";
import { nowDate } from "../../lib/time";
import {
  canUseAgent,
  loadAgent$,
  loadAutomationOwnerTimezone$,
  loadAutomationWorkflowRunTarget$,
  loadOwnedAutomation$,
  type AutomationActionInput,
  type WorkflowAutomationRunNowResult,
} from "./workflow-automation.service";
import { buildWorkflowScheduleAutomationBrief } from "./workflow-automation-brief.service";
import type { WorkflowAutomationContext } from "./workflow-automation-context.service";
import type { AutomationRow } from "./workflow-automation-enqueue.service";
import { runWorkflowAutomationNow$ } from "./workflow-automation-run.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { ensureWorkflowUserAutomationThread$ } from "./workflow-user-automation-thread.service";
import { OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE } from "./official-workflow-constants";

/**
 * Repeated "Run now" clicks are otherwise indistinguishable, so the request time
 * is this run's unique identifier.
 */
function manualTriggerContext(args: {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly requestedAt: Date;
  readonly sourceRunId?: string;
}): WorkflowAutomationContext {
  const requestedAt = args.requestedAt.toISOString();
  return {
    workflowName: args.workflowName,
    eventType: "manual",
    trigger: `manual run requested at ${requestedAt}.`,
    event: {
      automationId: args.automation.id,
      trigger: "manual",
      requestedAt,
      ...(args.sourceRunId === undefined
        ? {}
        : { sourceRunId: args.sourceRunId }),
    },
  };
}

export const runOwnedWorkflowAutomationNow$ = command(
  async (
    { set },
    args: AutomationActionInput,
    signal: AbortSignal,
  ): Promise<WorkflowAutomationRunNowResult> => {
    const owned = await set(loadOwnedAutomation$, args, signal);
    signal.throwIfAborted();
    if ("kind" in owned) {
      return owned;
    }
    const { automation } = owned;
    if (automation.officialBlueprintKey !== null) {
      return {
        kind: "conflict",
        message: OFFICIAL_WORKFLOW_AUTOMATION_ONLY_MESSAGE,
      };
    }
    const target = await set(
      loadAutomationWorkflowRunTarget$,
      {
        orgId: args.orgId,
        workflowId: automation.workflowId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!target) {
      return { kind: "not-found" };
    }
    const agent = await set(
      loadAgent$,
      {
        orgId: args.orgId,
        agentId: target.agentId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!agent) {
      return {
        kind: "conflict",
        message: "Cannot run: the workflow's agent no longer exists.",
      };
    }
    if (!canUseAgent(agent, args.member)) {
      return {
        kind: "forbidden",
        message: "You do not have access to the workflow's agent",
      };
    }

    const currentTime = nowDate();
    const ownerTimezone = await set(
      loadAutomationOwnerTimezone$,
      automation,
      signal,
    );
    signal.throwIfAborted();
    const chatThreadId = await set(
      ensureWorkflowUserAutomationThread$,
      {
        orgId: automation.orgId,
        userId: automation.ownerUserId,
        workflowId: automation.workflowId,
        agentId: target.agentId,
        workflowTitle: target.workflowTitle,
        currentTime,
      },
      signal,
    );
    signal.throwIfAborted();

    const manualContext = manualTriggerContext({
      automation,
      workflowName: target.workflowName,
      requestedAt: currentTime,
      ...(args.sourceRunId === undefined
        ? {}
        : { sourceRunId: args.sourceRunId }),
    });
    await set(
      runWorkflowAutomationNow$,
      {
        due: {
          automation,
          agentId: target.agentId,
          chatThreadId,
        },
        automationContext: manualContext,
        apiStartTime: currentTime.getTime(),
        triggerSource: manualTriggerSource(automation),
        triggerBrief:
          buildWorkflowScheduleAutomationBrief({
            createdAt: currentTime,
            scheduleType: automation.scheduleType,
            cronExpression: automation.cronExpression,
            intervalSeconds: automation.intervalSeconds,
            atTime: automation.atTime,
            automationTimezone: automation.timezone,
            userTimezone: ownerTimezone,
          }) ?? undefined,
        replacePendingScheduleTick: false,
      },
      signal,
    );
    signal.throwIfAborted();
    return { kind: "enqueued", chatThreadId };
  },
);
