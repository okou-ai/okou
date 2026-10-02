import { chatEventCommandResultSchema } from "./chat-event-append.service";
import { executeRawRows } from "../../lib/db-raw-rows";
import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { listPendingChatInputs } from "./chat-event-queue.service";
import {
  chatEventContextInsertSql,
  chatEventInsertSql,
  chatEventReplacementInsertSql,
  requireChatEventReplacementTarget,
  chatEventReplacementTargetSql,
  chatEventReplacementTargetSchema,
} from "./chat-event.service";
import type { ChatInputModelSelection } from "@okouai/api-contracts/contracts/chat-input-model";
import {
  createUserMessageDocument,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import type {
  WorkflowAutomationContext,
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import { measureWorkflowAdmissionStep } from "./workflow-queue-admission-timing.service";

export type AutomationRow = typeof workflowAutomations.$inferSelect;

export interface DueWorkflowAutomation {
  readonly automation: AutomationRow;
  // The owning agent is derived from the workflow row (hard 1:N); automations no
  // longer carry an agentId column, so callers resolve it and pass it here.
  readonly agentId: string;
  readonly chatThreadId: string;
  // One-time schedule automations are disabled as part of the optimistic claim.
  // That claimed row can still proceed through the run-start readability gate.
  readonly allowClaimedOnceScheduleAutomation?: boolean;
}

export type RunWorkflowAutomationResult = {
  readonly kind: "enqueued";
  readonly scheduleOccurrence?: "claimed" | "superseded";
};

export interface RunWorkflowAutomationNowArgs {
  readonly due: DueWorkflowAutomation;
  readonly automationContext: WorkflowAutomationContext;
  /** Stable ingress identity when a source callback may retry the same event. */
  readonly queueEventId?: string;
  readonly apiStartTime: number;
  readonly agentRunSource?: ChatAgentRunSourceAnnotation;
  /** Exact member connector that durably delivered this provider event. */
  readonly connectorSourceId?: string;
  // Display-only trigger summary used by workflow annotations and run history.
  readonly triggerBrief?: string;
  readonly triggerSource?: TriggerSource;
  /**
   * Automated schedule ticks replace this automation's still-pending tick.
   * Explicit manual runs set this false so every user action remains a
   * distinct queue item.
   */
  readonly replacePendingScheduleTick?: boolean;
  /**
   * Source transition committed in the same transaction as the queue event.
   * This callback is never serialized into the durable queue payload.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
  /**
   * Consumes the due schedule occurrence in the same transaction as the queue
   * event. Only journaled legacy Morning Brief ticks pass one.
   */
  readonly scheduleClaim?: WorkflowScheduleClaimPlan;
  readonly timing?: ApiDispatchTimingCollector;
}

export function scheduleTriggerContext(args: {
  readonly automation: AutomationRow;
  readonly workflowName: string;
  readonly firedAt: Date;
}): WorkflowAutomationContext {
  const firedAt = args.firedAt.toISOString();
  const recurrence =
    args.automation.scheduleType === "loop"
      ? `every ${args.automation.intervalSeconds}s`
      : args.automation.cronExpression
        ? `cron "${args.automation.cronExpression}" in ${args.automation.timezone}`
        : `once in ${args.automation.timezone}`;
  return {
    workflowName: args.workflowName,
    eventType: "schedule",
    trigger: `schedule fired at ${firedAt} (${recurrence}).`,
    event: {
      automationId: args.automation.id,
      trigger: "schedule",
      scheduleType: args.automation.scheduleType,
      cronExpression: args.automation.cronExpression,
      intervalSeconds: args.automation.intervalSeconds,
      atTime: args.automation.atTime,
      timezone: args.automation.timezone,
      firedAt,
    },
  };
}

export type WorkflowQueueAdmissionTransaction = Tx;

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

export interface WorkflowScheduleClaimPlan {
  readonly claimId: string;
  readonly automationId: string;
  readonly orgId: string;
  readonly ownerUserId: string;
  readonly workflowId: string;
  readonly scheduledAnchorAt: Date;
  readonly claimedAt: Date;
}

export class ScheduleOccurrenceUnavailableError extends Error {
  constructor() {
    super("Schedule occurrence was consumed by a competing tick");
    this.name = "ScheduleOccurrenceUnavailableError";
  }
}

interface WorkflowAutomationQueueEventArgs {
  readonly modelSelection: ChatInputModelSelection;
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

export async function workflowAutomationQueueEventWriter(
  db: Db,
  args: WorkflowAutomationQueueEventArgs,
): Promise<(tx: Db | Tx) => Promise<string | null>> {
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
  return async (tx) => {
    // The entry owns its context row; it commits with the event that points
    // at it, under the same id.
    const values = {
      id: args.queueEventId ?? randomUUID(),
      chatThreadId: args.chatThreadId,
      eventType: "input.automation" as const,
      modelSelection: args.modelSelection,
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
    await measureWorkflowAdmissionStep(
      args.timing,
      "api_dispatch_workflow_enqueue_event_context_insert",
      async () => {
        const contextInsert = chatEventContextInsertSql(values);
        if (contextInsert) {
          await tx.execute(contextInsert);
        }
      },
    );
    const inserted = await measureWorkflowAdmissionStep(
      args.timing,
      "api_dispatch_workflow_enqueue_event_insert",
      async () => {
        return (
          (
            await executeRawRows(
              tx,
              chatEventInsertSql(
                values,
                args.queueEventId === undefined ? "none" : "id",
              ),
              chatEventCommandResultSchema,
            )
          )[0] ?? null
        );
      },
    );
    if (!inserted && args.queueEventId === undefined) {
      throw new Error("Workflow queue event insert returned no row");
    }
    return inserted?.id ?? null;
  };
}

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
    await executeRawRows(
      db,
      chatEventReplacementInsertSql(
        requireChatEventReplacementTarget(
          await executeRawRows(
            db,
            chatEventReplacementTargetSql(eventId),
            chatEventReplacementTargetSchema,
          ),
        ),
        {
          chatThreadId: args.chatThreadId,
          eventType: "control.revoke",
          runId: null,
          content: null,
        },
      ),
      chatEventCommandResultSchema,
    );
  }
}
