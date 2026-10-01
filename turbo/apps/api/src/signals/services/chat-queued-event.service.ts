import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { ModelProviderCredentialScope } from "@okouai/api-contracts/contracts/model-providers";
import {
  chatEvents,
  type ChatEventUserMessage,
} from "@okouai/db/schema/chat-event";
import { and, eq, exists, isNull, notExists, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { Tx } from "../../lib/db-types";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import type { ChildAutonomyBudget } from "./autonomy-budget.service";
import {
  canonicalChatEventUserMessage,
  canonicalChatInputModelSelection,
} from "./canonical-chat-event-read.service";
import { loadChatQueueHead } from "./chat-event-queue.service";
import {
  type LoadedChatEventReplacementTarget,
  type NewChatEvent,
  replaceLoadedChatEvent,
} from "./chat-event.service";
import { withRunModelAnnotation } from "./chat-user-message.service";

type DbTransaction = Tx;

export type QueuedUserMessageContextType = NonNullable<
  (typeof chatEvents.$inferSelect)["contextType"]
>;

export type QueuedUserMessageTriggerSource =
  | "web"
  | "agent"
  | "slack"
  | "discord"
  | "feishu"
  | "lark"
  | "teams"
  | "telegram"
  | "agentphone"
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
  contextType: Exclude<QueuedUserMessageContextType, "feishu">,
): QueuedUserMessageTriggerSource {
  switch (contextType) {
    case "web":
    case "slack":
    case "discord":
    case "teams":
    case "telegram":
    case "agentphone": {
      return contextType;
    }
    case "agent_run": {
      return "agent";
    }
    case "automation": {
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

/**
 * The one queue consumption form: a launch claims the thread's FIFO head by
 * appending a replacement that carries the new run id and revokes the head.
 * Prompts and automation events are claimed alike; anything an automation
 * binds to its run is recorded by the automation after the run exists.
 */
export interface QueueFirstRunAssociation {
  readonly threadId: string;
  readonly eventId: string;
}

export type QueueFirstRunClaimResult =
  | {
      readonly kind: "claimed";
      readonly createdAt: Date;
    }
  | { readonly kind: "lost" };

const queueFirstAdmissionTransaction = Symbol("queueFirstAdmissionTransaction");

export type QueueFirstRunAdmission =
  | { readonly kind: "blocked" }
  | {
      readonly kind: "idle";
      readonly [queueFirstAdmissionTransaction]?: {
        readonly transaction: DbTransaction;
        readonly head: QueueFirstClaimHead;
      };
    };

export type QueueFirstRunSessionSnapshotState =
  | "binding_changed"
  | "current"
  | "session_changed"
  | "unvalidated";

/** Whether the outer ChatEvent row is an unclaimed, unrevoked prompt. */
export function queuedUserMessageExists(): SQL {
  return exists(
    new QueryBuilder()
      .select({ id: queuedChatEvent.id })
      .from(queuedChatEvent)
      .where(
        and(
          eq(queuedChatEvent.id, chatEvents.id),
          eq(queuedChatEvent.eventType, "input.prompt" satisfies ChatEventType),
          isNull(queuedChatEvent.runId),
          notExists(
            new QueryBuilder()
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
    modelSelection: head.modelSelection,
  };
}

function queueFirstClaimHeadBase(db: DbTransaction) {
  return db
    .select({
      ...queueFirstReplacementTargetFields,
      userMessage: canonicalChatEventUserMessage().as("user_message"),
      modelSelection: canonicalChatInputModelSelection().as("model_selection"),
    })
    .from(chatEvents);
}

async function loadQueueFirstClaimHeadById(
  db: DbTransaction,
  threadId: string,
  eventId: string,
) {
  const [head] = await queueFirstClaimHeadBase(db)
    .where(
      and(eq(chatEvents.id, eventId), eq(chatEvents.chatThreadId, threadId)),
    )
    .limit(1);
  return head ?? null;
}

/** The thread's FIFO head with the fields its claim replacement needs. */
async function loadQueueFirstClaimHead(db: DbTransaction, threadId: string) {
  const head = await loadChatQueueHead(db, threadId);
  return head ? await loadQueueFirstClaimHeadById(db, threadId, head.id) : null;
}

type QueueFirstClaimHead = Awaited<ReturnType<typeof loadQueueFirstClaimHead>>;

function queueFirstClaimSnapshotFromHead(
  head: QueueFirstClaimHead,
  args: QueueFirstClaimArgs,
): QueueFirstClaimSnapshot | null {
  if (
    !head ||
    head.id !== args.eventId ||
    (head.eventType !== "input.prompt" && head.eventType !== "input.automation")
  ) {
    return null;
  }
  if (!head.userMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  return {
    target: replacementTargetFromQueueHead(head),
    routingContextType:
      head.eventType === "input.automation"
        ? "automation"
        : requiredQueuedUserMessageContextType(head.contextType),
    replacement: {
      chatThreadId: args.threadId,
      eventType: "input.prompt",
      ...(head.modelSelection === null
        ? {}
        : { modelSelection: head.modelSelection }),
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
  return queueFirstClaimSnapshotFromHead(
    await loadQueueFirstClaimHead(db, args.threadId),
    args,
  );
}

async function loadQueueFirstAdmissionProjection(
  db: DbTransaction,
  args: {
    readonly association: QueueFirstRunAssociation;
  },
): Promise<{
  readonly admissionBlocked: boolean;
  readonly head: QueueFirstClaimHead;
} | null> {
  const { threadId, eventId } = args.association;
  // The association names a candidate; it must still be the FIFO head.
  const pendingHead = await loadChatQueueHead(db, threadId);
  const isExpectedHead = pendingHead?.id === eventId;
  return {
    admissionBlocked: false,
    head: isExpectedHead
      ? await loadQueueFirstClaimHeadById(db, threadId, eventId)
      : null,
  };
}

/**
 * Resolve the thread admission consumed by queue claim. The read is a hint:
 * launch's final active-run insert is the authoritative per-thread lock, and
 * the head's unique revoke edge makes the claim itself exclusive.
 */
export async function resolveQueueFirstRunAdmission(
  db: DbTransaction,
  args: {
    readonly association: QueueFirstRunAssociation;
    readonly sessionSnapshotState: QueueFirstRunSessionSnapshotState;
    readonly timing: ApiDispatchTimingCollector;
  },
): Promise<QueueFirstRunAdmission> {
  let outcome: QueueFirstRunAdmission["kind"] | undefined;
  return await args.timing.measure(
    "api_dispatch_resolve_queue_first_admission",
    "nested",
    async () => {
      const projection = await args.timing.measure(
        "api_dispatch_queue_first_admission_projection",
        "nested",
        async () => {
          return await loadQueueFirstAdmissionProjection(db, args);
        },
      );
      if (!projection || projection.admissionBlocked) {
        outcome = "blocked";
        return { kind: "blocked" };
      }

      outcome = "idle";
      return Object.freeze({
        kind: "idle",
        [queueFirstAdmissionTransaction]: {
          transaction: db,
          head: projection.head,
        },
      });
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
  return await args.timing.measure(
    "api_dispatch_claim_queue_first_message",
    "nested",
    async () => {
      if (args.admission.kind === "blocked") {
        outcome = "lost";
        return { kind: "lost" };
      }

      const admissionProjection =
        args.admission[queueFirstAdmissionTransaction];
      const snapshot = await args.timing.measure(
        "api_dispatch_resolve_queue_first_claim_snapshot",
        "nested",
        async () => {
          return admissionProjection?.transaction === db
            ? queueFirstClaimSnapshotFromHead(admissionProjection.head, args)
            : await resolveQueueFirstClaimSnapshot(db, args);
        },
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
      );
      // The replacement's unique revoke edge is the claim's only mutual
      // exclusion: a concurrent claim, recall or rejection that appended first
      // makes this insert a no-op, and this launch loses its claim.
      if (!claimed) {
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
