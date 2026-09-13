import type { TriggerSource } from "@okouai/api-contracts/contracts/logs";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  pendingChatQueueEventCondition,
  staleChatEventQueueThreadIds,
} from "./chat-event-queue.service";
import { insertChatEvent, replaceChatEvent } from "./chat-event.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  createUserMessageDocument,
  withAgentRunSourceAnnotation,
  type ChatAgentRunSourceAnnotation,
} from "./chat-user-message.service";
import type {
  WorkflowAutomationEventPayload,
  WorkflowAutomationEventType,
} from "./workflow-automation-context.service";
import type { Tx } from "../../lib/db-types";
import { manualTriggerSource } from "./workflow-automation-trigger-source";
import { canonicalChatEventUserMessage } from "./canonical-chat-event-read.service";

const automationEventRevoker = alias(chatEvents, "automation_event_revoker");

export type WorkflowQueueAdmissionTransaction = Tx;

async function chatEventQueueAdmissionLock(
  tx: WorkflowQueueAdmissionTransaction,
  chatThreadId: string,
): Promise<void> {
  // Serialize every admission and claim transaction for the same chat thread.
  const lockKey = `chat_event_queue:${chatThreadId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function pendingTickExistsForAutomation(
  db: Pick<Db, "select">,
  automationId: string,
): Promise<boolean> {
  const [tick] = await db
    .select({ id: chatEvents.id })
    .from(chatAutomationContext)
    .innerJoin(
      chatEvents,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatEvents.contextId, chatAutomationContext.id),
      ),
    )
    .where(
      and(
        eq(chatAutomationContext.automationId, automationId),
        chatEventTypeIn(["input.automation"]),
        isNull(chatEvents.runId),
        notExists(
          db
            .select({ id: automationEventRevoker.id })
            .from(automationEventRevoker)
            .where(eq(automationEventRevoker.revokesEventId, chatEvents.id)),
        ),
      ),
    )
    .limit(1);
  return tick !== undefined;
}

type WorkflowQueueAdmission =
  | { readonly kind: "inserted"; readonly eventId: string }
  | { readonly kind: "coalesced" };

export type PersistWorkflowQueueSourceTransition = (
  tx: WorkflowQueueAdmissionTransaction,
) => Promise<void>;

interface WorkflowQueueAdmissionArgs {
  readonly automation: typeof workflowAutomations.$inferSelect;
  readonly workflowName: string;
  readonly displayPrompt: string;
  readonly agentRunSource?: ChatAgentRunSourceAnnotation;
  readonly workflowAutomationEventType?: WorkflowAutomationEventType;
  readonly workflowAutomationEventPayload?: WorkflowAutomationEventPayload;
  readonly connectorSourceId?: string;
  readonly publicBrand?: PublicBrand;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource;
  readonly triggerBrief: string | undefined;
  readonly coalescePendingScheduleRun: boolean;
  /**
   * Atomically transitions a provider-owned source event only after its
   * workflow queue item has been inserted. Throwing rolls back both writes.
   */
  readonly persistSourceTransition?: PersistWorkflowQueueSourceTransition;
}

async function attemptWorkflowQueueAdmission(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
): Promise<WorkflowQueueAdmission> {
  const { automation } = args;
  return await db.transaction(async (tx) => {
    await chatEventQueueAdmissionLock(tx, args.chatThreadId);

    if (
      args.coalescePendingScheduleRun &&
      automation.kind === "schedule" &&
      (await pendingTickExistsForAutomation(tx, automation.id))
    ) {
      return { kind: "coalesced" };
    }

    const automationUserMessage = createUserMessageDocument({
      text: args.displayPrompt,
      nonContentPart: {
        type: "automation",
        workflowName: args.workflowName,
        workflowId: automation.workflowId,
        ...(args.triggerBrief === undefined
          ? {}
          : { automationBrief: args.triggerBrief }),
      },
    });
    const userMessage = args.agentRunSource
      ? withAgentRunSourceAnnotation(automationUserMessage, args.agentRunSource)
      : automationUserMessage;
    const inserted = await insertChatEvent(tx, {
      chatThreadId: args.chatThreadId,
      eventType: "input.automation",
      content: null,
      userMessage,
      runId: null,
      automationId: automation.id,
      workflowName: args.workflowName,
      workflowAutomationEventType: args.workflowAutomationEventType,
      workflowAutomationEventPayload: args.workflowAutomationEventPayload,
      connectorSourceId: args.connectorSourceId,
      publicBrand: args.publicBrand,
      triggerBrief: args.triggerBrief ?? null,
    });
    if (!inserted) {
      throw new Error("Workflow queue event insert returned no row");
    }
    await args.persistSourceTransition?.(tx);
    return { kind: "inserted", eventId: inserted.id };
  });
}

/**
 * Persist every fired automation as a pending input event. The locked
 * coalescing predicate is unchanged: schedule automations have at most one
 * unclaimed, unrevoked event when the caller enables coalescing.
 */
export async function admitWorkflowAutomationEvent(
  db: Db,
  args: WorkflowQueueAdmissionArgs,
): Promise<WorkflowQueueAdmission> {
  return await attemptWorkflowQueueAdmission(db, args);
}

export interface PendingWorkflowQueueEvent {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly automationId: string | null;
  readonly chatThreadId: string;
  readonly triggerSource: TriggerSource | null;
  readonly triggerBrief: string | null;
  readonly workflowName: string | null;
  readonly workflowAutomationEventType: string | null;
  readonly workflowAutomationEventPayload: WorkflowAutomationEventPayload | null;
  readonly connectorSourceId: string | undefined;
  readonly publicBrand: PublicBrand | null;
}

/**
 * Load the automation queue head. Pending user events always win and any
 * active run blocks the whole thread. Missing automation context is returned
 * with null launch fields so the drain can reject the persisted input and
 * continue instead of leaving the thread stuck.
 *
 * A concurrently deleted thread can remove the selected event before this
 * lookup; that canonical deletion race returns null rather than failing.
 */
export async function loadNextWorkflowQueueEvent(
  db: Db,
  chatThreadId: string,
  queueItemCreatedBefore?: Date,
): Promise<PendingWorkflowQueueEvent | null> {
  return await db.transaction(async (tx) => {
    await chatEventQueueAdmissionLock(tx, chatThreadId);
    const [event] = await tx
      .select({
        id: chatEvents.id,
        orgId: agents.orgId,
        userId: chatThreads.userId,
        automationId: chatAutomationContext.automationId,
        automationKind: workflowAutomations.kind,
        chatThreadId: chatEvents.chatThreadId,
        triggerBrief: chatAutomationContext.triggerBrief,
        workflowName: chatAutomationContext.workflowName,
        workflowAutomationEventType: chatAutomationContext.eventType,
        workflowAutomationEventPayload: chatAutomationContext.eventPayload,
        connectorSourceId: chatAutomationContext.connectorSourceId,
        publicBrand: chatAutomationContext.publicBrand,
      })
      .from(chatEvents)
      .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .leftJoin(
        chatAutomationContext,
        and(
          eq(chatEvents.contextType, "automation"),
          eq(chatAutomationContext.id, chatEvents.contextId),
        ),
      )
      .leftJoin(
        workflowAutomations,
        eq(workflowAutomations.id, chatAutomationContext.automationId),
      )
      .where(
        and(
          eq(chatEvents.chatThreadId, chatThreadId),
          pendingChatQueueEventCondition(tx),
          chatEventTypeIn(["input.automation"]),
          queueItemCreatedBefore
            ? lt(chatEvents.createdAt, queueItemCreatedBefore)
            : undefined,
          notExists(
            tx
              .select({ id: chatEvents.id })
              .from(chatEvents)
              .where(
                and(
                  eq(chatEvents.chatThreadId, chatThreadId),
                  pendingChatQueueEventCondition(tx),
                  chatEventTypeIn(["input.prompt"]),
                ),
              ),
          ),
          notExists(
            tx
              .select({ id: agentRuns.id })
              .from(agentRuns)
              .where(
                and(
                  eq(agentRuns.chatThreadId, chatThreadId),
                  inArray(agentRuns.status, ["queued", "pending", "running"]),
                  isNotNull(agentRuns.triggerSource),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(chatEvents.createdAt), asc(chatEvents.id))
      .limit(1);
    if (!event) {
      return null;
    }
    return {
      ...event,
      connectorSourceId: event.connectorSourceId ?? undefined,
      publicBrand: event.publicBrand,
      triggerSource:
        event.automationKind === null
          ? null
          : manualTriggerSource({ kind: event.automationKind }),
    };
  });
}

async function loadAutomationRejectionPayload(
  db: Pick<Db, "select">,
  eventId: string,
) {
  const [event] = await db
    .select({
      automationId: chatAutomationContext.automationId,
      triggerBrief: chatAutomationContext.triggerBrief,
      userMessage: canonicalChatEventUserMessage(),
      workflowId: workflows.id,
      workflowName: workflows.name,
    })
    .from(chatEvents)
    .leftJoin(
      chatAutomationContext,
      and(
        eq(chatEvents.contextType, "automation"),
        eq(chatAutomationContext.id, chatEvents.contextId),
      ),
    )
    .leftJoin(
      workflowAutomations,
      eq(workflowAutomations.id, chatAutomationContext.automationId),
    )
    .leftJoin(workflows, eq(workflows.id, workflowAutomations.workflowId))
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  return event ?? null;
}

async function pendingAutomationEventStillExists(
  db: Pick<Db, "select">,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  const pending = await loadPendingChatQueueEvent(db, args);
  return pending?.eventType === "input.automation";
}

/** Reject an unfireable automation event while it still owns the queue head. */
export async function rejectWorkflowQueueEvent(
  db: Db,
  args: {
    readonly chatThreadId: string;
    readonly eventId: string;
    readonly reason: string;
  },
): Promise<boolean> {
  return await db.transaction(async (tx) => {
    if (!(await lockChatQueueThread(tx, args.chatThreadId))) {
      return false;
    }
    // The event owned the runnable head before launch. A user message or run
    // may win the thread while launch is in flight, but a permanent conflict
    // must still consume this trigger instead of making it retry later.
    if (!(await pendingAutomationEventStillExists(tx, args))) {
      return false;
    }
    const payload = await loadAutomationRejectionPayload(tx, args.eventId);
    if (!payload) {
      return false;
    }
    const userMessage =
      payload.userMessage ??
      (payload.workflowName === null
        ? null
        : createUserMessageDocument({
            text: null,
            nonContentPart: {
              type: "automation",
              workflowName: payload.workflowName,
              ...(payload.workflowId === null
                ? {}
                : { workflowId: payload.workflowId }),
              ...(payload.triggerBrief === null
                ? {}
                : { automationBrief: payload.triggerBrief }),
            },
          }));
    if (!userMessage) {
      return false;
    }
    const rejected = await replaceChatEvent(tx, args.eventId, {
      chatThreadId: args.chatThreadId,
      eventType: "input.rejected",
      userMessage,
      runId: null,
      error: args.reason,
      ...(payload.automationId === null
        ? {}
        : { automationId: payload.automationId }),
      triggerBrief: payload.triggerBrief,
    });
    return rejected !== null;
  });
}

export async function staleChatThreadQueueThreadIds(
  db: Db,
  args: {
    readonly createdAtOrAfter: Date;
    readonly createdBefore: Date;
    readonly limit: number;
    readonly chatThreadIds?: readonly string[];
  },
  signal: AbortSignal,
): Promise<readonly string[]> {
  return await staleChatEventQueueThreadIds(db, args, signal);
}
