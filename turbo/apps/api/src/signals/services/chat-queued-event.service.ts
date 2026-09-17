import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatAutomationContext } from "@okouai/db/schema/chat-automation-context";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import {
  and,
  asc,
  eq,
  exists,
  isNull,
  notExists,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { pgNullDecoder } from "../../lib/db-structured-result";
import type { Tx } from "../../lib/db-types";
import type { Db } from "../external/db";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { INITIAL_AUTONOMY_BUDGET } from "./autonomy-budget.constants";
import {
  childAutonomyBudget,
  type ChildAutonomyBudget,
} from "./autonomy-budget.service";
import {
  canonicalChatEventUserMessage,
  parseCanonicalChatEventRequiredOfficialWorkflowIds,
} from "./canonical-chat-event-read.service";
import { chatThreadAdmissionBlocked } from "./chat-active-run.service";
import {
  chatQueueEventPriority,
  listPendingChatQueueEvents,
  loadPendingChatQueueEvent,
  lockChatQueueThread,
  pendingChatQueueEventCondition,
} from "./chat-event-queue.service";
import { touchChatThreadLastMessageAt } from "./chat-event-shared.service";
import { chatEventTypeIn } from "./chat-event-type.service";
import {
  insertChatEvent,
  type LoadedChatEventReplacementTarget,
  type NewChatEvent,
  replaceChatEvent,
  replaceLoadedChatEvent,
  revokeChatEvent,
} from "./chat-event.service";
import {
  agentRunSourceAnnotation,
  withRunModelAnnotation,
} from "./chat-user-message.service";
import { webChatQueueContextFromContextId } from "./web-chat-public-brand-context.service";

type DbTransaction = Tx;

export type QueuedUserMessageContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

export type QueuedUserMessageTriggerSource =
  | "web"
  | "agent"
  | "slack"
  | "feishu"
  | "teams"
  | "telegram"
  | "agentphone"
  | "github"
  | "automation-schedule";

function unreachableQueuedContextType(contextType: never): never {
  throw new Error(`Unsupported queued context type: ${String(contextType)}`);
}

function requiredQueuedUserMessageContextType(
  contextType: QueuedUserMessageContextType | null,
): QueuedUserMessageContextType {
  if (contextType === null) {
    throw new Error("Queued user message is missing its context type");
  }
  return contextType;
}

export function queuedUserMessageTriggerSource(
  contextType: QueuedUserMessageContextType,
): QueuedUserMessageTriggerSource {
  switch (contextType) {
    case "web":
    case "slack":
    case "feishu":
    case "teams":
    case "telegram":
    case "agentphone":
    case "github": {
      return contextType;
    }
    case "agent_run": {
      return "agent";
    }
    case "automation":
    case "goal": {
      throw new Error(
        `${contextType} context cannot be routed as a queued user message`,
      );
    }
    default: {
      return unreachableQueuedContextType(contextType);
    }
  }
}

export function isWebChatContextType(
  contextType: QueuedUserMessageContextType,
): contextType is Extract<QueuedUserMessageContextType, "web" | "agent_run"> {
  return contextType === "web" || contextType === "agent_run";
}

const queuedChatEvent = alias(chatEvents, "queued_chat_event");
const queuedChatEventRevoker = alias(chatEvents, "queued_chat_event_revoker");
const queueFirstReplacementTargetFields = {
  id: chatEvents.id,
  chatThreadId: chatEvents.chatThreadId,
  createdAt: chatEvents.createdAt,
  eventType: chatEvents.eventType,
  contextType: chatEvents.contextType,
  contextId: chatEvents.contextId,
} as const;

export interface QueuedUserMessage {
  readonly id: string;
  readonly createdAt: Date;
  readonly userMessage: ChatEventUserMessage;
  readonly requiredOfficialWorkflowIds?: readonly string[];
  readonly publicBrand: PublicBrand | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly autonomyBudget:
    | ChildAutonomyBudget
    | { readonly kind: "unavailable"; readonly message: string };
}

export type QueueFirstRunAssociation =
  | {
      readonly kind: "user_message";
      readonly threadId: string;
      readonly eventId: string;
      readonly admissionTime: number;
    }
  | {
      readonly kind: "automation_event";
      readonly threadId: string;
      readonly eventId: string;
      readonly prompt: string;
      readonly automationId: string;
    };

export type QueueFirstRunClaimResult =
  | {
      readonly kind: "claimed";
      readonly createdAt: Date;
    }
  | { readonly kind: "lost" };

export type QueueFirstRunAdmission =
  | { readonly kind: "blocked" }
  | { readonly kind: "idle" };

export type QueueFirstRunSessionSnapshotState =
  | "binding_changed"
  | "current"
  | "session_changed"
  | "unvalidated";

/**
 * Establish the shared thread lock for every event-backed queue claim,
 * rejection, and revocation.
 */
export async function lockUserMessageQueueThread(
  db: Db,
  threadId: string,
): Promise<boolean> {
  return await lockChatQueueThread(db, threadId);
}

/** Whether the outer ChatEvent row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(db: Pick<Db, "select">): SQL {
  return exists(
    db
      .select({ id: queuedChatEvent.id })
      .from(queuedChatEvent)
      .where(
        and(
          eq(queuedChatEvent.id, chatEvents.id),
          eq(queuedChatEvent.eventType, "input.prompt" satisfies ChatEventType),
          isNull(queuedChatEvent.runId),
          notExists(
            db
              .select({ id: queuedChatEventRevoker.id })
              .from(queuedChatEventRevoker)
              .where(
                eq(queuedChatEventRevoker.revokesEventId, queuedChatEvent.id),
              ),
          ),
        ),
      ),
  );
}

function resolveQueuedOfficialWorkflowContext(args: {
  readonly contextType: QueuedUserMessageContextType;
  readonly contextId: string | null;
  readonly requiredOfficialWorkflowIds: readonly string[] | null;
}) {
  const hasClaim = args.requiredOfficialWorkflowIds !== null;
  if (hasClaim && !isWebChatContextType(args.contextType)) {
    throw new Error(
      `Queued ${args.contextType} input cannot carry an Official Workflow source claim`,
    );
  }
  const webContext =
    args.contextType === "web"
      ? webChatQueueContextFromContextId(args.contextId)
      : null;
  if (args.contextType === "web" && webContext === null) {
    throw new Error(`Invalid Web public-brand context: ${args.contextId}`);
  }
  // Both Official agent encodings carry a brand here, never the source Run.
  // Recognizing both also keeps annotation-based source/budget recovery shared.
  const officialAgentContext =
    args.contextType === "agent_run"
      ? webChatQueueContextFromContextId(args.contextId)
      : null;
  const contextRequiresClaim =
    webContext?.officialWorkflowClaimRequired === true ||
    officialAgentContext !== null;
  if (
    (contextRequiresClaim && !hasClaim) ||
    (hasClaim && webContext === null && officialAgentContext === null)
  ) {
    throw new Error(
      "Queued Official Workflow context and source claim do not match",
    );
  }
  return { webContext, officialAgentContext };
}

async function loadQueuedSourceAutonomyBudget(
  db: Db,
  args: {
    readonly userMessage: ChatEventUserMessage;
    readonly sourceAutonomyBudget: number | null;
    readonly officialAgentClaim: boolean;
  },
): Promise<number | null> {
  if (!args.officialAgentClaim) {
    return args.sourceAutonomyBudget;
  }
  const source = agentRunSourceAnnotation(args.userMessage);
  if (!source) {
    throw new Error(
      "Queued Official agent input is missing its source Run annotation",
    );
  }
  const [sourceRun] = await db
    .select({ autonomyBudget: agentRuns.autonomyBudget })
    .from(agentRuns)
    .where(eq(agentRuns.id, source.runId))
    .limit(1);
  return sourceRun?.autonomyBudget ?? null;
}

function queuedUserMessageAutonomyBudget(
  contextType: QueuedUserMessageContextType,
  sourceAutonomyBudget: number | null,
): QueuedUserMessage["autonomyBudget"] {
  if (contextType !== "agent_run") {
    return { kind: "ok", autonomyBudget: INITIAL_AUTONOMY_BUDGET };
  }
  if (sourceAutonomyBudget === null) {
    return {
      kind: "unavailable",
      message: "Agent source run no longer exists",
    };
  }
  return childAutonomyBudget(sourceAutonomyBudget);
}

export async function loadNextUnclaimedQueuedUserMessage(
  db: Db,
  threadId: string,
  queueItemCreatedBefore?: Date,
): Promise<QueuedUserMessage | null> {
  const pending = await listPendingChatQueueEvents(
    db,
    threadId,
    queueItemCreatedBefore,
  );
  const head = pending[0];
  if (!head || head.eventType !== "input.prompt") {
    return null;
  }
  const [event] = await db
    .select({
      id: chatEvents.id,
      createdAt: chatEvents.createdAt,
      userMessage: canonicalChatEventUserMessage(),
      requiredOfficialWorkflowIds: chatEvents.requiredOfficialWorkflowIds,
      modelProviderId: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderType: sql`NULL`.mapWith(pgNullDecoder),
      modelProviderCredentialScope: sql`NULL`.mapWith(pgNullDecoder),
      selectedModel: chatThreads.selectedModel,
      contextType: chatEvents.contextType,
      contextId: chatEvents.contextId,
      sourceAutonomyBudget: agentRuns.autonomyBudget,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatThreads.id, chatEvents.chatThreadId))
    .leftJoin(
      agentRuns,
      and(
        eq(chatEvents.contextType, "agent_run"),
        eq(agentRuns.id, chatEvents.contextId),
      ),
    )
    .where(
      and(
        eq(chatEvents.id, head.id),
        eq(chatEvents.chatThreadId, threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
      ),
    )
    .limit(1);
  if (!event) {
    return null;
  }
  if (!event.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const contextType = requiredQueuedUserMessageContextType(event.contextType);
  const requiredOfficialWorkflowIds =
    parseCanonicalChatEventRequiredOfficialWorkflowIds(
      event.requiredOfficialWorkflowIds,
    );
  const { webContext, officialAgentContext } =
    resolveQueuedOfficialWorkflowContext({
      contextType,
      contextId: event.contextId,
      requiredOfficialWorkflowIds,
    });
  const sourceAutonomyBudget = await loadQueuedSourceAutonomyBudget(db, {
    userMessage: event.userMessage,
    sourceAutonomyBudget: event.sourceAutonomyBudget,
    officialAgentClaim: officialAgentContext !== null,
  });
  const autonomyBudget = queuedUserMessageAutonomyBudget(
    contextType,
    sourceAutonomyBudget,
  );
  const { requiredOfficialWorkflowIds: _storedClaim, ...queuedEvent } = event;
  return {
    ...queuedEvent,
    userMessage: event.userMessage,
    ...(requiredOfficialWorkflowIds === null
      ? {}
      : {
          requiredOfficialWorkflowIds,
        }),
    publicBrand:
      webContext?.publicBrand ?? officialAgentContext?.publicBrand ?? null,
    contextType,
    autonomyBudget,
  };
}

export async function loadNextUnclaimedQueuedUserMessageId(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const [head] = await listPendingChatQueueEvents(db, threadId);
  return head?.eventType === "input.prompt" ? head.id : null;
}

type QueueFirstClaimArgs = QueueFirstRunAssociation & {
  readonly admission: QueueFirstRunAdmission;
  readonly runId: string;
  readonly selectedModel: string | null;
  readonly serviceTier?: ChatThreadServiceTier;
  readonly timing: ApiDispatchTimingCollector;
};

interface QueueFirstClaimSnapshot {
  readonly target: LoadedChatEventReplacementTarget;
  readonly replacement: NewChatEvent;
  readonly routingContextType: QueuedUserMessageContextType;
}

function replacementTargetFromQueueHead(
  head: LoadedChatEventReplacementTarget,
): LoadedChatEventReplacementTarget {
  return {
    id: head.id,
    chatThreadId: head.chatThreadId,
    createdAt: head.createdAt,
    eventType: head.eventType,
    contextType: head.contextType,
    contextId: head.contextId,
  };
}

async function resolveUserQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: Extract<QueueFirstClaimArgs, { readonly kind: "user_message" }>,
): Promise<QueueFirstClaimSnapshot | null> {
  const [head] = await db
    .select({
      ...queueFirstReplacementTargetFields,
      userMessage: canonicalChatEventUserMessage(),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (!head || head.eventType !== "input.prompt" || head.id !== args.eventId) {
    return null;
  }
  if (!head.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const contextType = requiredQueuedUserMessageContextType(head.contextType);
  return {
    target: replacementTargetFromQueueHead(head),
    routingContextType: contextType,
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage:
        args.selectedModel === null
          ? head.userMessage
          : withRunModelAnnotation(
              head.userMessage,
              args.selectedModel,
              args.serviceTier,
            ),
      runId: args.runId,
    },
  };
}

async function resolveAutomationEventQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: Extract<QueueFirstClaimArgs, { readonly kind: "automation_event" }>,
): Promise<QueueFirstClaimSnapshot | null> {
  const [head] = await db
    .select({
      ...queueFirstReplacementTargetFields,
      automationId: chatAutomationContext.automationId,
      automationKind: workflowAutomations.kind,
      userMessage: canonicalChatEventUserMessage(),
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
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        pendingChatQueueEventCondition(db),
      ),
    )
    .orderBy(
      chatQueueEventPriority(),
      asc(chatEvents.createdAt),
      asc(chatEvents.id),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (
    !head ||
    head.eventType !== "input.automation" ||
    head.id !== args.eventId ||
    head.automationId !== args.automationId ||
    head.automationKind === null
  ) {
    return null;
  }
  if (!head.userMessage) {
    throw new Error("Workflow queue event is missing its user message");
  }
  return {
    target: replacementTargetFromQueueHead(head),
    routingContextType: "automation",
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      userMessage:
        args.selectedModel === null
          ? head.userMessage
          : withRunModelAnnotation(
              head.userMessage,
              args.selectedModel,
              args.serviceTier,
            ),
      runId: args.runId,
    },
  };
}

async function resolveQueueFirstClaimSnapshot(
  db: DbTransaction,
  args: QueueFirstClaimArgs,
): Promise<QueueFirstClaimSnapshot | null> {
  if (args.kind === "user_message") {
    return await resolveUserQueueFirstClaimSnapshot(db, args);
  }
  if (args.kind === "automation_event") {
    return await resolveAutomationEventQueueFirstClaimSnapshot(db, args);
  }
  // Retained association shape cannot grant launch authority after retirement.
  return null;
}

function queueFirstRunAdmissionBlocked(
  db: DbTransaction,
  args: { readonly admissionTime: number; readonly threadId: string },
): Promise<boolean> {
  return chatThreadAdmissionBlocked(db, {
    threadId: args.threadId,
    apiStartTime: args.admissionTime,
  });
}

/**
 * Resolve the transaction-scoped thread admission consumed by queue claim.
 * Successful launches hold the organization admission lock; failed launches
 * preserve their existing thread-only arbitration.
 */
export async function resolveQueueFirstRunAdmission(
  db: DbTransaction,
  args: {
    readonly admissionTime: number;
    readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
    readonly threadAlreadyLocked?: true;
    readonly threadId: string;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunAdmission> {
  let outcome: QueueFirstRunAdmission["kind"] | undefined;
  return await args.timing.measure(
    "api_dispatch_resolve_queue_first_admission",
    "nested",
    async () => {
      const threadExists =
        args.threadAlreadyLocked ??
        (await args.timing.measure(
          "api_dispatch_queue_first_thread_lock_wait",
          "nested",
          async () => {
            return await lockUserMessageQueueThread(db, args.threadId);
          },
        ));
      if (!threadExists) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      if (await queueFirstRunAdmissionBlocked(db, args)) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      outcome = "idle";
      return { kind: "idle" };
    },
    () => {
      return {
        ...(outcome ? { queue_first_admission_result: outcome } : {}),
        thread_session_snapshot_state: args.sessionSnapshotState,
      };
    },
  );
}

export async function claimQueueFirstRunAssociation(
  db: DbTransaction,
  args: QueueFirstClaimArgs,
): Promise<QueueFirstRunClaimResult> {
  let outcome: "claimed" | "lost" | "error" = "error";
  const claimDimensions = {
    queue_first_association_kind: args.kind,
  };
  return await args.timing.measure(
    "api_dispatch_claim_queue_first_message",
    "nested",
    async () => {
      if (args.admission.kind === "blocked") {
        outcome = "lost";
        return { kind: "lost" };
      }

      const snapshot = await args.timing.measure(
        "api_dispatch_resolve_queue_first_claim_snapshot",
        "nested",
        async () => {
          return await resolveQueueFirstClaimSnapshot(db, args);
        },
        claimDimensions,
      );
      if (!snapshot) {
        outcome = "lost";
        return { kind: "lost" };
      }

      const claimed = await args.timing.measure(
        "api_dispatch_persist_queue_first_replacement",
        "nested",
        async () => {
          return await replaceLoadedChatEvent(db, snapshot.target, {
            ...snapshot.replacement,
            // This fresh server run UUID identifies its initial input claim.
            // The claim precedes the run INSERT in the same launch transaction;
            // active-input delivery never assigns this identity. Provenance
            // readers use its physical sequence as the run's lower bound.
            id: args.runId,
          });
        },
        claimDimensions,
      );
      if (!claimed) {
        if (args.kind !== "user_message") {
          throw new Error(`Claimed ${args.kind} queue event disappeared`);
        }
        outcome = "lost";
        return { kind: "lost" };
      }
      outcome = "claimed";
      return {
        kind: "claimed",
        createdAt: claimed.createdAt,
      };
    },
    () => {
      return { queue_first_claim_result: outcome };
    },
  );
}

/**
 * Discard a queue-first user message that never dispatched by appending a
 * tombstone. The revoke edge removes it from both queue and visible history.
 */
async function discardUnclaimedUserMessageInTransaction(
  db: DbTransaction,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<boolean> {
  if (!(await lockUserMessageQueueThread(db, args.threadId))) {
    return false;
  }
  const pending = await loadPendingChatQueueEvent(db, {
    chatThreadId: args.threadId,
    eventId: args.eventId,
  });
  if (pending?.eventType !== "input.prompt") {
    return false;
  }
  const tombstone = await revokeChatEvent(db, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "control.revoke",
    runId: null,
  });
  if (!tombstone) {
    throw new Error("Failed to append discarded user message tombstone");
  }
  return true;
}

export async function discardUnclaimedUserMessage(
  db: Db,
  args: {
    readonly threadId: string;
    readonly eventId: string;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await discardUnclaimedUserMessageInTransaction(tx, args);
  });
}

/**
 * Consume the current queue head without a run and append canonical user and
 * assistant replacements that explain a permanent integration admission
 * failure.
 */
interface FailQueuedUserMessageArgs {
  readonly threadId: string;
  readonly eventId: string;
  readonly assistantContent: string;
  readonly errorMarker: string;
  readonly currentTime: Date;
}

async function failQueuedUserMessageInTransaction(
  tx: DbTransaction,
  args: FailQueuedUserMessageArgs,
): Promise<{ readonly assistantEventId: string } | null> {
  if (!(await lockUserMessageQueueThread(tx, args.threadId))) {
    return null;
  }
  if (
    (await loadNextUnclaimedQueuedUserMessageId(tx, args.threadId)) !==
    args.eventId
  ) {
    return null;
  }

  const [queued] = await tx
    .select({
      userMessage: canonicalChatEventUserMessage(),
      createdAt: chatEvents.createdAt,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.id, args.eventId),
        eq(chatEvents.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
        isNull(chatEvents.runId),
      ),
    )
    .for("update", { of: chatEvents })
    .limit(1);
  if (!queued) {
    return null;
  }
  if (!queued.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  const terminalAt = new Date(
    Math.max(args.currentTime.getTime(), queued.createdAt.getTime() + 1),
  );

  const replacement = await replaceChatEvent(tx, args.eventId, {
    chatThreadId: args.threadId,
    eventType: "input.rejected",
    userMessage: queued.userMessage,
    runId: null,
    error: args.errorMarker,
    createdAt: terminalAt,
  });
  if (!replacement) {
    return null;
  }

  const assistant = await insertChatEvent(tx, {
    chatThreadId: args.threadId,
    eventType: "output.error",
    content: args.assistantContent,
    runId: null,
    error: args.errorMarker,
    createdAt: new Date(terminalAt.getTime() + 1),
  });
  if (!assistant) {
    throw new Error("Failed to append integration admission error");
  }
  await touchChatThreadLastMessageAt(tx, args.threadId, assistant.createdAt);
  return { assistantEventId: assistant.id };
}

export async function failQueuedUserMessage(
  db: Db,
  args: FailQueuedUserMessageArgs,
): Promise<{ readonly assistantEventId: string } | null> {
  return await db.transaction(async (tx) => {
    return await failQueuedUserMessageInTransaction(tx, args);
  });
}
