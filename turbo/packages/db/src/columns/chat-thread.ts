import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  varchar,
} from "drizzle-orm/pg-core";
import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agents } from "../schema/agent";
import { computerUseHosts } from "../schema/computer-use-host";
import type {
  ChatThreadDraftAttachments,
  ChatThreadDraftUserMessage,
} from "@okouai/db/jsonb-contracts/chat-thread";
import type { ModelSettings } from "@okouai/db/jsonb-contracts/chat-model-settings";

import type { ChatThreadProvenance } from "../schema/chat-thread";

/** Shared by the physical schema and the runtime application mapping. */
export function chatThreadColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    title: text("title"),
    /**
     * ID of the scheduled agent run this thread was started from, if any.
     * When set, the first run created in this thread is seeded with a system
     * prompt that points the agent at the local Claude Code and Codex session
     * files for direct analysis. Subsequent runs reuse the resulting session
     * context, so the prompt is only applied once.
     */
    sourceScheduleRunId: uuid("source_schedule_run_id"),
    /**
     * Canonical application session for runs admitted on this thread.
     * Every thread-bound run source resolves continuation through this binding.
     * No FK: binding writes must not lock agent_sessions, and a deleted session
     * resolves to "initialized" because continuity left-joins it.
     */
    agentSessionId: uuid("agent_session_id"),
    /**
     * Run whose final admission most recently established agentSessionId.
     * Provides route provenance for session rotation and binding snapshots.
     * No FK, for the same reason as agentSessionId; a dangling id is harmless.
     */
    agentSessionRunId: uuid("agent_session_run_id"),
    /** Canonical rich document for the thread composer's saved draft. */
    draftUserMessage:
      jsonb("draft_user_message").$type<ChatThreadDraftUserMessage>(),
    /**
     * Draft attachment metadata for the thread's composer. Only completed uploads.
     * Null when no draft attachments are saved.
     */
    draftAttachments:
      jsonb("draft_attachments").$type<ChatThreadDraftAttachments>(),
    /**
     * Slack-style watermark: the last timestamp up to which the user has read
     * messages in this thread. It normally advances to the latest run-finish
     * marker; marking the thread unread clears it. NULL means there is no read
     * watermark.
     */
    lastReadAt: timestamp("last_read_at"),
    /**
     * Legacy provider pin columns. Model-first chat threads now persist only
     * selectedModel and re-resolve provider routing from org policy for each run.
     */
    modelProviderId: uuid("model_provider_id"),
    modelProviderType: varchar("model_provider_type", { length: 50 }),
    modelProviderCredentialScope: varchar("model_provider_credential_scope", {
      length: 20,
    }),
    /** Per-thread selected model pin. Provider routing is resolved per run. */
    selectedModel: varchar("selected_model", { length: 255 }),
    /** Sparse per-model preferences copied from the member when created. */
    modelSettings: jsonb("model_settings")
      .$type<ModelSettings>()
      .default({})
      .notNull(),
    /** Legacy pre-GA column. Remove after the model-settings rollout settles. */
    reasoningEffort: varchar("reasoning_effort", {
      length: 20,
    }).$type<ReasoningEffort>(),
    /** Per-thread Codex service tier pin. Null means standard service tier. */
    codexServiceTier: varchar("codex_service_tier", {
      length: 20,
    }).$type<CodexServiceTier>(),
    /**
     * Per-thread built-in video generation model pin. Null falls through to the
     * member default and then to the system default. Generation parameters such
     * as aspect ratio and resolution stay per generation and are never pinned
     * here, so one thread can still produce more than one format.
     */
    selectedVideoModel: varchar("selected_video_model", { length: 255 }),
    /**
     * Per-thread built-in image generation model default. Null falls through to
     * the member default and then to the system default. Image parameters such
     * as size, aspect ratio, and quality remain per generation.
     */
    selectedImageModel: varchar("selected_image_model", { length: 255 }),
    computerUseHostId: uuid("computer_use_host_id").references(
      () => {
        return computerUseHosts.id;
      },
      { onDelete: "set null" },
    ),
    /**
     * Whether this thread may use Okou's managed cloud browser.
     * Mutually exclusive with computerUseHostId at application boundaries.
     */
    cloudBrowserEnabled: boolean("cloud_browser_enabled")
      .default(false)
      .notNull(),
    /**
     * Timestamp at which the user pinned this thread to the top of the sidebar.
     * NULL means unpinned. Pinned threads sort above unpinned; pinOrder controls
     * their manual order when stable navigation is enabled. Per `(user, agent)` because `chat_threads` rows
     * already carry `user_id` + `agent_id`.
     */
    pinnedAt: timestamp("pinned_at"),
    /** Fractional order within the pinned group; ties are resolved by thread ID. */
    pinOrder: text("pin_order"),
    /**
     * Whether the user archived this thread. Archived threads are hidden from
     * the default sidebar list; archiving never changes the title.
     */
    archived: boolean("archived").default(false).notNull(),
    /**
     * Timestamp at which the user manually renamed this thread.
     * NULL means the thread has never been renamed.
     * When set, automated title generation is suppressed.
     */
    renamedAt: timestamp("renamed_at"),
    /**
     * Most recent message timestamp, denormalized from chat_events.
     * Maintained app-side for direct user messages and terminal run-finished
     * markers via GREATEST() — monotonic, never rewound. Triggered/goal user
     * messages, billing rows, and other control rows do not advance it. Powers
     * the sidebar recency and unread watermark comparisons with index-driven
     * thread queries.
     */
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    /**
     * Server-private thread origin. Never exposed in a Chat or Settings
     * response and never supplied by a client. Nullable on purpose and
     * deliberately without a column default: an older API version that does not
     * know this column keeps creating unknown rows, which must not be read as
     * ordinary. See {@link ChatThreadProvenance}.
     */
    provenance: varchar("provenance", {
      length: 32,
    }).$type<ChatThreadProvenance>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
