import { resolveEnqueuedChatInputModel$ } from "./chat-input-model.service";
import { randomUUID } from "node:crypto";
import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, isNotNull } from "drizzle-orm";

import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import { writeDb$ } from "../external/db";
import { now, nowDate } from "../../lib/time";
import type { PreparedChatEventRow } from "./chat-event-append.service";
import { childAutonomyBudget } from "./autonomy-budget.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type {
  ChatQueueHeadContext,
  ChatQueueHeadRejection,
  ChatQueueRunAssembly,
} from "./chat-queue-run-assembly";
import {
  createUserMessageDocument,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import {
  dispatchConfiguredOfficialWorkflowReconciliation$,
  type OfficialWorkflowReconciliationResult,
} from "./official-workflow-reconciliation-dispatch.service";
import type {
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import {
  assembleWorkflowAutomationRun$,
  resolveWorkflowAutomationModelContext$,
  checkQueuedWorkflowLaunchReadiness$,
  type WorkflowModelContext,
} from "./workflow-automation-launch.service";
import { buildWorkflowAutomationQueuedLaunchMaterial } from "./workflow-automation-queued-launch-context.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { recordWorkflowAdmissionDuration } from "./workflow-queue-admission-timing.service";

/** Ordinary occurrence identity prepared by the poller before queue admission. */
export interface WorkflowScheduleClaimPlan {
  readonly claimId: string;
  readonly automationId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
  readonly scheduledAnchorAt: Date;
  readonly claimedAt: Date;
}

/**
 * Thrown inside the event transaction when a competing tick already consumed
 * the exact occurrence; it rolls the queue event back and the schedule stays
 * due for the cron's next read.
 */
export class ScheduleOccurrenceUnavailableError extends Error {
  constructor() {
    super("Schedule occurrence was consumed by a competing tick");
    this.name = "ScheduleOccurrenceUnavailableError";
  }
}

interface WorkflowAutomationQueueEventArgs {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly queueEventId?: string;
  readonly workflowName: string;
  readonly displayPrompt: string;
  readonly agentRunSource?: ChatAgentRunSourceAnnotation;
  readonly workflowAutomationEventType?: WorkflowAutomationEventType;
  readonly workflowAutomationEventPayload?: WorkflowAutomationEventPayload;
  readonly connectorSourceId?: string;
  readonly chatThreadId: string;
  readonly triggerBrief: string | undefined;
  readonly timing?: ApiDispatchTimingCollector;
}

/**
 * Prepare the run-less input, model selection and context before queue admission.
 * No database or transaction handle escapes in the returned ordinary values.
 */
function buildWorkflowAutomationQueueInput(
  args: WorkflowAutomationQueueEventArgs,
  displayName: string | null,
  modelSelection: ChatInputModelSelection,
) {
  const { automation } = args;
  const automationUserMessage = createUserMessageDocument({
    text: args.displayPrompt,
    nonContentPart: {
      type: "automation",
      workflowName: displayName?.trim() || args.workflowName,
      workflowId: automation.workflowId,
      ...(args.triggerBrief === undefined
        ? {}
        : { automationBrief: args.triggerBrief }),
    },
  });
  const userMessage = args.agentRunSource
    ? withAgentRunSourceAnnotation(automationUserMessage, args.agentRunSource)
    : automationUserMessage;
  const id = args.queueEventId ?? randomUUID();
  const createdAt = nowDate();
  const values = {
    id,
    createdAt,
    chatThreadId: args.chatThreadId,
    eventType: "input.automation" as const,
    modelSelection,
    content: null,
    userMessage,
    runId: null,
    automationId: automation.id,
    workflowName: args.workflowName,
    workflowAutomationEventType: args.workflowAutomationEventType,
    workflowAutomationEventPayload: args.workflowAutomationEventPayload,
    connectorSourceId: args.connectorSourceId,
    triggerBrief: args.triggerBrief ?? null,
  };
  return {
    values,
    event: {
      id,
      createdAt,
      chatThreadId: args.chatThreadId,
      eventType: "input.automation" as const,
      runId: null,
      payload: { userMessage },
      modelSelection: values.modelSelection,
      contextType: "automation",
      contextId: id,
    } satisfies PreparedChatEventRow,
    context: {
      id,
      createdAt,
      chatThreadId: args.chatThreadId,
      automationId: automation.id,
      workflowName: args.workflowName,
      eventType: args.workflowAutomationEventType ?? null,
      eventPayload: args.workflowAutomationEventPayload ?? null,
      connectorSourceId: args.connectorSourceId ?? null,
      triggerBrief: args.triggerBrief ?? null,
    },
    conflict:
      args.queueEventId === undefined ? ("none" as const) : ("id" as const),
  };
}

export type PreparedWorkflowAutomationQueueInput = ReturnType<
  typeof buildWorkflowAutomationQueueInput
>;

/** Resolve display and model data before admission, returning plain values. */
export const prepareWorkflowAutomationQueueInput$ = command(
  async (
    { set },
    args: WorkflowAutomationQueueEventArgs,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const startedAt = performance.now();
    const [workflow] = await db
      .select({ displayName: workflows.displayName })
      .from(workflows)
      .where(eq(workflows.id, args.automation.workflowId))
      .limit(1);
    signal.throwIfAborted();
    await recordWorkflowAdmissionDuration(
      args.timing,
      "api_dispatch_workflow_enqueue_display_name",
      performance.now() - startedAt,
    );
    signal.throwIfAborted();
    if (!workflow) {
      throw new Error(`Workflow not found: ${args.automation.workflowId}`);
    }
    const modelStartedAt = performance.now();
    const modelSelection = await set(
      resolveEnqueuedChatInputModel$,
      {
        threadId: args.chatThreadId,
        orgId: args.automation.orgId,
        userId: args.automation.ownerUserId,
      },
      signal,
    );
    await recordWorkflowAdmissionDuration(
      args.timing,
      "api_dispatch_workflow_enqueue_model_selection",
      performance.now() - modelStartedAt,
    );
    signal.throwIfAborted();
    return buildWorkflowAutomationQueueInput(
      args,
      workflow.displayName,
      modelSelection,
    );
  },
);

interface QueuedAutomationEvent {
  readonly id: string;
  readonly chatThreadId: string;
  readonly automationId: string;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly eventType: string | null;
  readonly eventPayload: WorkflowAutomationEventPayload | null;
  readonly connectorSourceId: string | null;
}

/** The head's automation context, by its primary key. */
const loadQueuedAutomationEvent$ = command(
  async (
    { set },
    head: ChatQueueHeadContext,
    signal: AbortSignal,
  ): Promise<QueuedAutomationEvent | null> => {
    const db = set(writeDb$);
    if (head.contextId === null) {
      return null;
    }
    const [context] = await db
      .select({
        automationId: chatAutomationContext.automationId,
        triggerBrief: chatAutomationContext.triggerBrief,
        workflowName: chatAutomationContext.workflowName,
        eventType: chatAutomationContext.eventType,
        eventPayload: chatAutomationContext.eventPayload,
        connectorSourceId: chatAutomationContext.connectorSourceId,
      })
      .from(chatAutomationContext)
      .where(eq(chatAutomationContext.id, head.contextId))
      .limit(1);
    signal.throwIfAborted();
    return context
      ? { id: head.id, chatThreadId: head.chatThreadId, ...context }
      : null;
  },
);

interface LaunchTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
}

const loadLaunchTarget$ = command(
  async (
    { set },
    automationId: string,
    signal: AbortSignal,
  ): Promise<LaunchTarget | null> => {
    const db = set(writeDb$);
    const [row] = await db
      .select({
        automation: workflowAutomationColumns(),
        agentId: workflows.agentId,
      })
      .from(workflowAutomations)
      .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
      .where(eq(workflowAutomations.id, automationId))
      .limit(1);
    signal.throwIfAborted();
    return row ?? null;
  },
);

const resolveAutonomyBudget$ = command(
  async (
    { set },
    event: QueuedAutomationEvent,
    automation: typeof workflowAutomations.$inferSelect,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "ok"; readonly autonomyBudget: number }
    | {
        readonly kind: "invalid";
        readonly error: { readonly code: string; readonly message: string };
      }
  > => {
    const db = set(writeDb$);
    const label =
      event.eventType === "manual" ? "Manual automation" : "Chat run finished";
    const sourceRunId =
      event.eventType === "chat-run-finished"
        ? event.eventPayload?.["runId"]
        : event.eventType === "manual"
          ? event.eventPayload?.["sourceRunId"]
          : undefined;
    if (event.eventType !== "chat-run-finished" && sourceRunId === undefined) {
      return { kind: "ok", autonomyBudget: automation.autonomyBudget };
    }
    if (typeof sourceRunId !== "string") {
      return {
        kind: "invalid",
        error: {
          code: "AUTONOMY_SOURCE_UNAVAILABLE",
          message: `${label} event is missing its source run`,
        },
      };
    }
    const [sourceRun] = await db
      .select({ autonomyBudget: agentRuns.autonomyBudget })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, sourceRunId), isNotNull(agentRuns.triggerSource)),
      )
      .limit(1);
    signal.throwIfAborted();
    const sourceAutonomyBudget = sourceRun?.autonomyBudget ?? null;
    if (sourceAutonomyBudget === null) {
      return {
        kind: "invalid",
        error: {
          code: "AUTONOMY_SOURCE_UNAVAILABLE",
          message: `${label} source run no longer exists`,
        },
      };
    }
    const derived = childAutonomyBudget(sourceAutonomyBudget);
    return derived.kind === "exhausted"
      ? {
          kind: "invalid",
          error: {
            code: "AUTONOMY_BUDGET_EXHAUSTED",
            message: AUTONOMY_BUDGET_EXHAUSTED_MESSAGE,
          },
        }
      : { kind: "ok", autonomyBudget: derived.autonomyBudget };
  },
);

function reconciliationConflictMessage(
  reconciled: OfficialWorkflowReconciliationResult,
): string {
  // A `retry` result (a superseded reconciliation, or an event preparation or
  // watch registration failure) rejects the head like any other failure; the
  // next trigger reconciles again.
  return reconciled.kind === "needs-reconfiguration" ||
    reconciled.kind === "retry"
    ? reconciled.message
    : "Official Workflow automation no longer exists";
}

/** Build the run for a readable automation target, or reject the head. */
const assembleAutomationRunForTarget$ = command(
  async (
    { set },
    args: {
      readonly head: ChatQueueHeadContext;
      readonly event: QueuedAutomationEvent;
      readonly target: LaunchTarget;
      readonly modelContext: WorkflowModelContext;
      readonly timing: ApiDispatchTimingCollector;
      readonly rejectionUserId: string;
    },
    signal: AbortSignal,
  ): Promise<ChatQueueRunAssembly> => {
    const { head, event, target } = args;
    const rejection = (error: {
      readonly code: string;
      readonly message: string;
    }): ChatQueueHeadRejection => {
      return { error, userId: args.rejectionUserId };
    };
    const conflict = (message: string): ChatQueueRunAssembly => {
      return {
        kind: "rejected",
        rejection: rejection({ code: "CONFLICT", message }),
      };
    };
    const material = buildWorkflowAutomationQueuedLaunchMaterial({
      workflowName: event.workflowName,
      eventType: event.eventType,
      eventPayload: event.eventPayload,
      automation: target.automation,
      agentId: target.agentId,
      chatThreadId: event.chatThreadId,
    });
    if (!material) {
      return conflict("Workflow queue event payload is unreadable");
    }
    const autonomyBudget = await set(
      resolveAutonomyBudget$,
      event,
      target.automation,
      signal,
    );
    signal.throwIfAborted();
    if (autonomyBudget.kind === "invalid") {
      return { kind: "rejected", rejection: rejection(autonomyBudget.error) };
    }
    const triggerSource: TriggerSource = manualTriggerSource(target.automation);
    const assembled = await set(
      assembleWorkflowAutomationRun$,
      {
        due: {
          automation: target.automation,
          agentId: target.agentId,
          chatThreadId: event.chatThreadId,
          allowClaimedOnceScheduleAutomation:
            material.allowClaimedOnceScheduleAutomation,
        },
        queueEventId: event.id,
        modelContext: args.modelContext,
        timing: args.timing,
        apiStartTime: head.apiStartTime,
        prompt: material.prompt,
        triggerBrief: event.triggerBrief ?? undefined,
        triggerSource,
        ...(event.connectorSourceId
          ? { connectorSourceId: event.connectorSourceId }
          : {}),
        appendSystemPrompt: material.appendSystemPrompt,
        callbacks: material.callbacks,
        autonomyBudget: autonomyBudget.autonomyBudget,
        activePreviousRunPolicy: material.activePreviousRunPolicy,
        recordLastRunId: material.recordLastRunId,
        recordLastRunAt: material.recordLastRunAt,
        dispatchFailedCallbacks: head.dispatchFailedCallbacks,
      },
      signal,
    );
    signal.throwIfAborted();
    if (assembled.kind === "conflict") {
      return conflict(assembled.message);
    }
    if (assembled.kind === "run_error") {
      return {
        kind: "rejected",
        rejection: rejection(assembled.response.body.error),
      };
    }
    return {
      kind: "assembled",
      run: assembled.run,
      rejection,
      launched: { kind: "automation", input: assembled.launched },
    };
  },
);

function workflowQueueFailure(
  userId: string,
  error: { readonly code: string; readonly message: string },
): ChatQueueRunAssembly {
  return { kind: "rejected", rejection: { error, userId } };
}

/**
 * The automation assembler: build run parameters from the head's automation
 * context, reconciling an Official Workflow first. A reconciliation busy
 * elsewhere leaves the head waiting; every other failure rejects it.
 */
export const assembleQueuedAutomationRun$ = command(
  async (
    { set },
    head: ChatQueueHeadContext,
    signal: AbortSignal,
  ): Promise<ChatQueueRunAssembly> => {
    const unreadable = (message: string): ChatQueueRunAssembly => {
      return {
        kind: "rejected",
        rejection: {
          error: { code: "CONFLICT", message },
          userId: head.userId,
        },
      };
    };

    const event = await set(loadQueuedAutomationEvent$, head, signal);
    signal.throwIfAborted();
    if (!event) {
      return unreadable("Workflow queue event payload is unreadable");
    }
    const loadedTarget = await set(
      loadLaunchTarget$,
      event.automationId,
      signal,
    );
    signal.throwIfAborted();
    if (!loadedTarget) {
      return unreadable("Workflow automation no longer exists");
    }
    let target = loadedTarget;
    const conflict = (message: string): ChatQueueRunAssembly => {
      return workflowQueueFailure(
        target.automation.ownerUserId ?? head.userId,
        { code: "CONFLICT", message },
      );
    };
    if (target.automation.officialBlueprintKey !== null) {
      const reconciled = await set(
        dispatchConfiguredOfficialWorkflowReconciliation$,
        {
          orgId: target.automation.orgId,
          member: { userId: target.automation.ownerUserId, role: "member" },
          workflowId: target.automation.workflowId,
          targetAutomationId: target.automation.id,
        },
        signal,
      );
      signal.throwIfAborted();
      if (reconciled.kind !== "current") {
        return conflict(reconciliationConflictMessage(reconciled));
      }
      const reconciledTarget = await set(
        loadLaunchTarget$,
        event.automationId,
        signal,
      );
      signal.throwIfAborted();
      if (!reconciledTarget) {
        return conflict("Official Workflow automation no longer exists");
      }
      target = reconciledTarget;
    }
    const material = buildWorkflowAutomationQueuedLaunchMaterial({
      workflowName: event.workflowName,
      eventType: event.eventType,
      eventPayload: event.eventPayload,
      automation: target.automation,
      agentId: target.agentId,
      chatThreadId: event.chatThreadId,
    });
    if (!material) {
      return conflict("Workflow queue event payload is unreadable");
    }
    const timing = new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_entrypoint_gap",
      "nested",
      head.apiStartTime,
    );
    const readiness = await set(
      checkQueuedWorkflowLaunchReadiness$,
      {
        automation: target.automation,
        agentId: target.agentId,
        activePreviousRunPolicy: material.activePreviousRunPolicy,
        timing,
        allowClaimedOnceScheduleAutomation:
          material.allowClaimedOnceScheduleAutomation,
      },
      signal,
    );
    if (readiness) {
      return readiness.kind === "conflict"
        ? conflict(readiness.message)
        : workflowQueueFailure(
            target.automation.ownerUserId ?? head.userId,
            readiness.response.body.error,
          );
    }
    const modelStartedAt = now();
    const modelContext = await set(
      resolveWorkflowAutomationModelContext$,
      {
        orgId: target.automation.orgId,
        userId: target.automation.ownerUserId,
        chatThreadId: event.chatThreadId,
        eventId: event.id,
      },
      signal,
    );
    timing.recordElapsed(
      "api_dispatch_pre_create_agent_workflow_automation_resolve_model_context",
      "nested",
      modelStartedAt,
    );
    return await set(
      assembleAutomationRunForTarget$,
      {
        head,
        event,
        target,
        rejectionUserId: target.automation.ownerUserId ?? head.userId,
        modelContext,
        timing,
      },
      signal,
    );
  },
);
