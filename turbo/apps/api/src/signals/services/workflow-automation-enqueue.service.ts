import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { and, eq, isNull, ne, notExists, or } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { PreparedChatEventRow } from "./chat-event-append.service";
import { randomUUID } from "node:crypto";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { prepareChatEvent } from "./chat-event.service";
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
import type { WorkflowQueueReceipt } from "./workflow-input-queue.service";
import type { GmailQueueSource } from "./workflow-gmail-queue.service";
import type { GoogleCalendarQueueSource } from "./workflow-google-calendar-queue.service";
import type { GoogleFormsQueueSource } from "./workflow-google-forms-queue.service";
import type { GoogleMeetQueueSource } from "./workflow-google-meet-queue.service";
import type { NotionQueueSource } from "./workflow-notion-queue.service";
import type { StripeQueueSource } from "./workflow-stripe-queue.service";
import type { ConnectorRuntimeSnapshot } from "./connector-catalog-runtime.service";

export type WorkflowQueueSourcePlan =
  | WorkflowQueueReceipt
  | { readonly kind: "gmail"; readonly source: GmailQueueSource }
  | {
      readonly kind: "google-calendar";
      readonly source: GoogleCalendarQueueSource;
    }
  | { readonly kind: "google-forms"; readonly source: GoogleFormsQueueSource }
  | { readonly kind: "google-meet"; readonly source: GoogleMeetQueueSource }
  | { readonly kind: "notion"; readonly source: NotionQueueSource }
  | {
      readonly kind: "stripe";
      readonly source: StripeQueueSource;
      readonly snapshot: ConnectorRuntimeSnapshot;
    };

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
   * Plain source facts are never serialized into the durable queue payload.
   */
  readonly sourcePlan?: WorkflowQueueSourcePlan;
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
  readonly displayName: string | null;
}

/** Prepare the immutable event and context before entering the SQL-only owner. */
export function workflowAutomationQueueEventPlan(
  args: WorkflowAutomationQueueEventArgs,
) {
  const { automation } = args;
  const automationUserMessage = createUserMessageDocument({
    text: args.displayPrompt,
    nonContentPart: {
      type: "automation",
      workflowName: args.displayName?.trim() || args.workflowName,
      workflowId: automation.workflowId,
      ...(args.triggerBrief === undefined
        ? {}
        : { automationBrief: args.triggerBrief }),
    },
  });
  const userMessage = args.agentRunSource
    ? withAgentRunSourceAnnotation(automationUserMessage, args.agentRunSource)
    : automationUserMessage;
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
  const event = prepareChatEvent(values);
  return {
    row: event.row,
    context: {
      id: event.row.id,
      chatThreadId: args.chatThreadId,
      automationId: automation.id,
      workflowName: args.workflowName,
      eventType: args.workflowAutomationEventType ?? null,
      eventPayload: args.workflowAutomationEventPayload ?? null,
      connectorSourceId: args.connectorSourceId ?? null,
      triggerBrief: args.triggerBrief ?? null,
      createdAt: event.row.createdAt,
    },
    conflict:
      args.queueEventId === undefined ? ("none" as const) : ("id" as const),
  };
}

export function pendingWorkflowScheduleTickCondition(args: {
  readonly chatThreadId: string;
  readonly automationId: string;
  readonly eventId: string;
}) {
  const revoker = alias(chatEvents, "workflow_tick_revoker");
  return and(
    eq(chatEvents.chatThreadId, args.chatThreadId),
    eq(chatEvents.eventType, "input.automation"),
    isNull(chatEvents.runId),
    eq(chatEvents.contextType, "automation"),
    eq(chatAutomationContext.automationId, args.automationId),
    or(
      isNull(chatAutomationContext.eventType),
      ne(chatAutomationContext.eventType, "manual"),
    ),
    ne(chatEvents.id, args.eventId),
    notExists(
      new QueryBuilder()
        .select({ id: revoker.id })
        .from(revoker)
        .where(eq(revoker.revokesEventId, chatEvents.id)),
    ),
  );
}

/** Every target is an unconsumed input. Preserve its immutable context edge. */
export function workflowScheduleRevocationRows(args: {
  readonly chatThreadId: string;
  readonly targets: readonly Pick<
    typeof chatEvents.$inferSelect,
    "id" | "createdAt" | "contextType" | "contextId"
  >[];
  readonly currentTime: Date;
}): readonly PreparedChatEventRow[] {
  return args.targets.map((target) => {
    return {
      id: randomUUID(),
      chatThreadId: args.chatThreadId,
      eventType: "control.revoke",
      runId: null,
      payload: null,
      createdAt: new Date(
        Math.max(args.currentTime.getTime(), target.createdAt.getTime() + 1),
      ),
      revokesEventId: target.id,
      contextType: target.contextType,
      contextId: target.contextId,
    };
  });
}
