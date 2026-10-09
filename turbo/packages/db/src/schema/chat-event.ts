import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type {
  ChatEventPayload,
  ChatInputModelSelection,
} from "@okouai/db/jsonb-contracts/chat-event";
import type { ChatEventType } from "@okouai/api-contracts/contracts/chat-events";
import type { RunFailureReasonToken } from "@okouai/api-contracts/contracts/run-failure-reasons";
import {
  check,
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  integer,
  bigint,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { chatThreads } from "./chat-thread";
export type {
  ChatEventAttachFileMetadata,
  ChatEventAttachFileMetadataList,
  ChatEventPayload,
  ChatEventUserMessage,
  ChatEventUsageKindBreakdown,
  ChatEventUsagePayload,
  ChatEventUsageProviderBreakdown,
} from "@okouai/db/jsonb-contracts/chat-event";

/**
 * Shared literal predicate for partial-index selection and ON CONFLICT
 * inference. Keep the values inline rather than parameterizing this condition.
 */
export function chatEventTerminalPredicate(eventType: SQLWrapper): SQL {
  return sql`${eventType} IN ('run.completed', 'run.failed', 'run.cancelled')`;
}

/**
 * Shared literal predicate for the run-less input partial index. Pending-input
 * reads must repeat it verbatim so the planner can prove the index applies;
 * parameterized event types would hide that implication from generic plans.
 */
export function chatEventRunlessInputPredicate(
  runId: SQLWrapper,
  eventType: SQLWrapper,
): SQL {
  return sql`${runId} IS NULL AND ${eventType} IN ('input.prompt', 'input.automation', 'input.budget')`;
}

/**
 * Physical storage for the immutable ChatEvent stream.
 * Each row is one typed event belonging to a chat_thread.
 *
 * Current user, automation, and budget inputs are persisted immediately. A
 * run-less, unrevoked prompt or automation is pending thread queue state. A
 * run-scoped budget is pending active input. Their run-attributed replacements
 * are the immutable claims.
 *
 * Assistant rows are appended after run output exists. Event-backed rows are
 * one row per assistant-visible agent output event; result-only CLI output can
 * be projected from a terminal
 * "result" event. Failed runs append an assistant row carrying the terminal
 * error message. `run_event_sequence_number` is the upstream run-event
 * coordinate used for reconciliation and final-answer selection. The
 * deterministic primary key derived from `run_event_id` is the first
 * deduplication guard; `(run_id, run_event_sequence_number)` is a second guard.
 *
 * Terminal-state assistant rows use the `run.completed | run.failed |
 * run.cancelled` event types.
 */
export const chatEvents = pgTable(
  "chat_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    chatThreadId: uuid("chat_thread_id")
      .references(
        () => {
          return chatThreads.id;
        },
        { onDelete: "cascade" },
      )
      .notNull(),
    // Attribution only: identifies the run that consumed or produced this row.
    // A null value on an eligible current unrevoked input identifies pending state.
    runId: uuid("run_id"),
    revokesEventId: uuid("revokes_event_id"),
    eventType: text("event_type").$type<ChatEventType>().notNull(),
    payload: jsonb("payload").$type<ChatEventPayload>(),
    // Server-private enqueue decision; kept outside the strict public payload.
    modelSelection: jsonb("model_selection").$type<ChatInputModelSelection>(),
    failureReason: text("failure_reason").$type<RunFailureReasonToken>(),
    /**
     * Server-owned authority for an Official Workflow prompt awaiting a Run.
     * Keep it outside the strict public payload so an older API can continue
     * reading and archiving the immutable event during a rolling deployment.
     */
    requiredOfficialWorkflowIds: uuid("required_official_workflow_ids")
      .array()
      .$type<readonly string[]>(),
    /**
     * Input source discriminator and optional polymorphic context pointer.
     *
     * `web` and `automation` can identify an input without a context row.
     * Web queue launch identity uses reserved UUID sentinels when present.
     * For other values, contextId selects the row named by contextType.
     * contextId is not unique: when a pending event is claimed, the revoke +
     * insert replacement reuses it. Legal (eventType, contextType)
     * combinations are enforced by the NewChatEvent
     * TypeScript write union, not by SQL.
     */
    contextType: text("context_type").$type<
      | "web"
      | "slack"
      | "discord"
      | "feishu"
      | "teams"
      | "telegram"
      | "agentphone"
      | "automation"
      | "agent_run"
    >(),
    contextId: uuid("context_id"),
    runEventSequenceNumber: integer("run_event_sequence_number"),
    /** Upstream run-event ID or a deterministic seed for synthesized rows. */
    runEventId: text("run_event_id"),
    /** Strictly increasing thread position; it may start above 1 and have gaps. */
    seqId: bigint("seq_id", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      check(
        "chat_events_model_selection_check",
        sql`${table.modelSelection} IS NULL OR COALESCE((
          jsonb_typeof(${table.modelSelection}) = 'object' AND
          jsonb_typeof(${table.modelSelection} -> 'selectedModel') = 'string' AND
          char_length(${table.modelSelection} ->> 'selectedModel') > 0
        ), false)`,
      ),
      check(
        "chat_events_model_annotation_check",
        sql`NOT jsonb_path_exists(${table.payload}, '$.userMessage.parts[*] ? (@.type == "model" && (!exists(@.selectedModel) || @.selectedModel.type() != "string" || @.selectedModel == ""))')`,
      ),
      index("idx_chat_events_created_at_id").on(table.createdAt, table.id),
      index("idx_chat_events_thread_created").on(
        table.chatThreadId,
        table.createdAt,
      ),
      index("idx_chat_events_thread_run_terminal_created")
        .on(table.chatThreadId, table.createdAt.desc())
        .where(chatEventTerminalPredicate(table.eventType)),
      index("chat_events_thread_runless_input_seq_idx")
        .on(table.chatThreadId, table.seqId)
        .where(chatEventRunlessInputPredicate(table.runId, table.eventType)),
      uniqueIndex("chat_events_revokes_event_id_not_null_unique")
        .on(table.revokesEventId)
        .where(sql`${table.revokesEventId} IS NOT NULL`),
      index("chat_events_input_automation_context_idx")
        .on(table.contextId)
        .where(sql`${table.eventType} = 'input.automation'`),
      uniqueIndex("chat_events_run_event_seq_unique").on(
        table.runId,
        table.runEventSequenceNumber,
      ),
      uniqueIndex("chat_events_thread_seq_unique").on(
        table.chatThreadId,
        table.seqId,
      ),
      uniqueIndex("chat_events_run_terminal_unique")
        .on(table.runId)
        .where(chatEventTerminalPredicate(table.eventType)),
      // control.interrupt rows carry their target run in run_id, so only one
      // interrupt may target a run.
      uniqueIndex("chat_events_control_interrupt_run_id_unique")
        .on(table.runId)
        .where(
          sql`${table.eventType} = 'control.interrupt' AND ${table.runId} IS NOT NULL`,
        ),
      check(
        "chat_events_event_type_check",
        sql`${table.eventType} IN (
          'input.prompt',
          'input.automation',
          'input.budget',
          'input.rejected',
          'output.message',
          'output.error',
          'output.followups',
          'run.completed',
          'run.failed',
          'run.cancelled',
          'control.interrupt',
          'control.revoke',
          'usage.recorded'
        )`,
      ),
      check(
        "chat_events_input_user_message_payload_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.budget', 'input.rejected')
          OR (
            ${table.payload} IS NOT NULL
            AND ${table.payload} ? 'userMessage'
          )`,
      ),
      check(
        "chat_events_failure_reason_event_type_check",
        sql`${table.failureReason} IS NULL OR ${table.eventType} = 'run.failed'`,
      ),
      check(
        "chat_events_input_payload_content_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.budget', 'input.rejected')
          OR ${table.payload} IS NULL
          OR NOT (${table.payload} ? 'content')`,
      ),
      check(
        "chat_events_official_workflow_queue_claim_check",
        sql`${table.requiredOfficialWorkflowIds} IS NULL OR (
          ${table.eventType} = 'input.prompt'
          AND cardinality(${table.requiredOfficialWorkflowIds}) > 0
        )`,
      ),
      check(
        "chat_events_context_pair_check",
        sql`${table.contextId} IS NULL OR ${table.contextType} IS NOT NULL`,
      ),
      check(
        "chat_events_context_type_check",
        sql`${table.contextType} IN (
          'web',
          'slack',
          'discord',
          'feishu',
          'teams',
          'telegram',
          'agentphone',
          'automation',
          'agent_run'
        )`,
      ),
      check(
        "chat_events_input_context_type_check",
        sql`${table.eventType} NOT IN ('input.prompt', 'input.automation', 'input.budget', 'input.rejected')
          OR ${table.contextType} IS NOT NULL`,
      ),
    ];
  },
);
