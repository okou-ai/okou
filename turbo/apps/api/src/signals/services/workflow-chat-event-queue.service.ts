import { resolveEnqueuedChatInputModel } from "./chat-input-model.service";
import { randomUUID } from "node:crypto";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { AUTONOMY_BUDGET_EXHAUSTED_MESSAGE } from "../../lib/error";
import type { Tx } from "../../lib/db-types";
import { writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { PreparedChatEventRow } from "./chat-event-append.service";
import {
  childAutonomyBudget,
  loadRunAutonomyBudget,
} from "./autonomy-budget.service";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { listPendingChatInputs } from "./chat-event-queue.service";
import {
  insertChatEvent,
  insertChatEventContext,
  revokeChatEvent,
} from "./chat-event.service";
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
import { assembleWorkflowAutomationRun } from "./workflow-automation-launch.service";
import { buildWorkflowAutomationQueuedLaunchMaterial } from "./workflow-automation-queued-launch-context.service";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { measureWorkflowAdmissionStep } from "./workflow-queue-admission-timing.service";

export type WorkflowQueueAdmissionTransaction = Tx;

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

export type ScheduleUnclaimed = "superseded";

export type WorkflowScheduleClaimAttempt =
  | { readonly kind: "claimed"; readonly claimId: string }
  | { readonly kind: "unavailable" };

/**
 * Consumes the due Morning Brief occurrence in the transaction that writes its
 * queue event. The schedule CAS, the journal row and the queue event commit
 * together, so a claim never outlives a rolled-back event and an admitted event
 * always carries the occurrence it was fired for.
 */
export interface WorkflowScheduleClaimPlan {
  readonly claim: (
    tx: WorkflowQueueAdmissionTransaction,
  ) => Promise<WorkflowScheduleClaimAttempt>;
  readonly bindQueueEvent: (
    tx: WorkflowQueueAdmissionTransaction,
    args: { readonly claimId: string; readonly queueEventId: string },
  ) => Promise<void>;
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
export async function prepareWorkflowAutomationQueueInput(
  db: Db,
  args: WorkflowAutomationQueueEventArgs,
) {
  const { automation } = args;
  const [workflow] = await measureWorkflowAdmissionStep(
    args.timing,
    "api_dispatch_workflow_enqueue_display_name",
    async () => {
      return await db
        .select({ displayName: workflows.displayName })
        .from(workflows)
        .where(eq(workflows.id, automation.workflowId))
        .limit(1);
    },
  );
  if (!workflow) {
    throw new Error(`Workflow not found: ${automation.workflowId}`);
  }
  const automationUserMessage = createUserMessageDocument({
    text: args.displayPrompt,
    nonContentPart: {
      type: "automation",
      workflowName: workflow.displayName?.trim() || args.workflowName,
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
    modelSelection: await measureWorkflowAdmissionStep(
      args.timing,
      "api_dispatch_workflow_enqueue_model_selection",
      async () => {
        return await resolveEnqueuedChatInputModel(db, {
          threadId: args.chatThreadId,
          orgId: automation.orgId,
          userId: automation.ownerUserId,
        });
      },
    ),
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

export type PreparedWorkflowAutomationQueueInput = Awaited<
  ReturnType<typeof prepareWorkflowAutomationQueueInput>
>;

/** Legacy non-Forms callers still use the generic transaction callback. */
export function workflowAutomationQueueEventWriter(
  prepared: PreparedWorkflowAutomationQueueInput,
  timing: ApiDispatchTimingCollector | undefined,
): (tx: Db | Tx) => Promise<string | null> {
  return async (tx) => {
    await measureWorkflowAdmissionStep(
      timing,
      "api_dispatch_workflow_enqueue_event_context_insert",
      async () => {
        await insertChatEventContext(tx, prepared.values);
      },
    );
    const inserted = await measureWorkflowAdmissionStep(
      timing,
      "api_dispatch_workflow_enqueue_event_insert",
      async () => {
        return await insertChatEvent(tx, prepared.values, prepared.conflict);
      },
    );
    if (!inserted && prepared.conflict === "none") {
      throw new Error("Workflow queue event insert returned no row");
    }
    return inserted?.id ?? null;
  };
}

/**
 * The automation's still-unconsumed events on its thread, read in bounded
 * steps without a join: the thread's pending automation inputs, their
 * context ids by primary key, then which of those contexts belong to this
 * automation. `scheduleTicksOnly` drops explicit manual runs, which are never
 * coalesced.
 */
async function pendingAutomationEventIds(
  db: Pick<Db, "select">,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly scheduleTicksOnly?: boolean;
  },
): Promise<readonly string[]> {
  const pending = await listPendingChatInputs(db, {
    chatThreadId: args.chatThreadId,
    eventTypes: ["input.automation"],
  });
  if (pending.length === 0) {
    return [];
  }
  const contexts = await db
    .select({ eventId: chatEvents.id, contextId: chatEvents.contextId })
    .from(chatEvents)
    .where(
      and(
        inArray(
          chatEvents.id,
          pending.map(({ id }) => {
            return id;
          }),
        ),
        eq(chatEvents.contextType, "automation"),
      ),
    );
  const contextIds = contexts.flatMap(({ contextId }) => {
    return contextId === null ? [] : [contextId];
  });
  if (contextIds.length === 0) {
    return [];
  }
  const owned = await db
    .select({
      id: chatAutomationContext.id,
      eventType: chatAutomationContext.eventType,
    })
    .from(chatAutomationContext)
    .where(
      and(
        inArray(chatAutomationContext.id, contextIds),
        eq(chatAutomationContext.automationId, args.automationId),
      ),
    );
  const ownedIds = new Set(
    owned.flatMap(({ id, eventType }) => {
      return args.scheduleTicksOnly === true && eventType === "manual"
        ? []
        : [id];
    }),
  );
  return contexts.flatMap(({ eventId, contextId }) => {
    return contextId !== null && ownedIds.has(contextId) ? [eventId] : [];
  });
}

/** Whether the automation still has an unconsumed event on its thread. */
export async function hasPendingAutomationEvent(
  db: Pick<Db, "select">,
  args: { readonly chatThreadId: string; readonly automationId: string },
): Promise<boolean> {
  return (await pendingAutomationEventIds(db, args)).length > 0;
}

/**
 * Schedule coalescing belongs to the schedule trigger: when a new tick is
 * enqueued, the automation's older unconsumed schedule ticks are revoked;
 * explicit manual runs stay distinct queue items. `excludeEventId` keeps the
 * new tick itself when the revoke runs in its insert transaction. A revoke
 * that loses its unique revoke edge means the tick was already picked; the
 * new tick is enqueued either way, so an occasional extra tick can run.
 */
export async function revokePendingScheduleTicks(
  db: Db | Tx,
  args: {
    readonly chatThreadId: string;
    readonly automationId: string;
    readonly excludeEventId?: string;
  },
): Promise<void> {
  const pending = await pendingAutomationEventIds(db, {
    chatThreadId: args.chatThreadId,
    automationId: args.automationId,
    scheduleTicksOnly: true,
  });
  for (const eventId of pending) {
    if (eventId === args.excludeEventId) {
      continue;
    }
    await revokeChatEvent(db, eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "control.revoke",
      runId: null,
    });
  }
}

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
async function loadQueuedAutomationEvent(
  db: Db,
  head: ChatQueueHeadContext,
): Promise<QueuedAutomationEvent | null> {
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
  return context
    ? { id: head.id, chatThreadId: head.chatThreadId, ...context }
    : null;
}

interface LaunchTarget {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly agentId: string;
}

async function loadLaunchTarget(
  db: Db,
  automationId: string,
): Promise<LaunchTarget | null> {
  const [row] = await db
    .select({
      automation: workflowAutomationColumns(),
      agentId: workflows.agentId,
    })
    .from(workflowAutomations)
    .innerJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(eq(workflowAutomations.id, automationId))
    .limit(1);
  return row ?? null;
}

async function resolveAutonomyBudget(
  db: Db,
  event: QueuedAutomationEvent,
  automation: typeof workflowAutomations.$inferSelect,
): Promise<
  | { readonly kind: "ok"; readonly autonomyBudget: number }
  | {
      readonly kind: "invalid";
      readonly error: { readonly code: string; readonly message: string };
    }
> {
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
  const sourceAutonomyBudget = await loadRunAutonomyBudget(db, sourceRunId);
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
}

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
async function assembleAutomationRunForTarget(
  db: Db,
  args: {
    readonly head: ChatQueueHeadContext;
    readonly event: QueuedAutomationEvent;
    readonly target: LaunchTarget;
    readonly rejection: (error: {
      readonly code: string;
      readonly message: string;
    }) => ChatQueueHeadRejection;
  },
  signal: AbortSignal,
): Promise<ChatQueueRunAssembly> {
  const { head, event, target, rejection } = args;
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
  const autonomyBudget = await resolveAutonomyBudget(
    db,
    event,
    target.automation,
  );
  signal.throwIfAborted();
  if (autonomyBudget.kind === "invalid") {
    return { kind: "rejected", rejection: rejection(autonomyBudget.error) };
  }
  const triggerSource: TriggerSource = manualTriggerSource(target.automation);
  const assembled = await assembleWorkflowAutomationRun(
    db,
    {
      due: {
        automation: target.automation,
        agentId: target.agentId,
        chatThreadId: event.chatThreadId,
        allowClaimedOnceScheduleAutomation:
          material.allowClaimedOnceScheduleAutomation,
      },
      queueEventId: event.id,
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
    launched: assembled.launched,
  };
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
    const db = set(writeDb$);
    const unreadable = (message: string): ChatQueueRunAssembly => {
      return {
        kind: "rejected",
        rejection: {
          error: { code: "CONFLICT", message },
          userId: head.userId,
        },
      };
    };

    const event = await loadQueuedAutomationEvent(db, head);
    signal.throwIfAborted();
    if (!event) {
      return unreadable("Workflow queue event payload is unreadable");
    }
    const loadedTarget = await loadLaunchTarget(db, event.automationId);
    signal.throwIfAborted();
    if (!loadedTarget) {
      return unreadable("Workflow automation no longer exists");
    }
    let target = loadedTarget;
    const rejection = (error: {
      readonly code: string;
      readonly message: string;
    }): ChatQueueHeadRejection => {
      return {
        error,
        userId: target.automation.ownerUserId ?? head.userId,
      };
    };
    const conflict = (message: string): ChatQueueRunAssembly => {
      return {
        kind: "rejected",
        rejection: rejection({ code: "CONFLICT", message }),
      };
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
      const reconciledTarget = await loadLaunchTarget(db, event.automationId);
      signal.throwIfAborted();
      if (!reconciledTarget) {
        return conflict("Official Workflow automation no longer exists");
      }
      target = reconciledTarget;
    }
    return await assembleAutomationRunForTarget(
      db,
      { head, event, target, rejection },
      signal,
    );
  },
);
