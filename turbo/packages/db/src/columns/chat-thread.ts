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
import type { ModelSettings } from "@okouai/db/jsonb-contracts/chat-model-settings";

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
    /** Confirmed native identity; cleared when the next Run starts execution. */
    framework: varchar("framework", { length: 64 }),
    frameworkSessionId: varchar("framework_session_id", { length: 255 }),
    /**
     * Latest started Run, without a Run FK. Framework/session remain null until
     * that Run confirms native identity; together they identify its native files.
     * Historical readers remain authoritative until older Threads are backfilled.
     */
    frameworkSessionRunId: uuid("framework_session_run_id"),
    /**
     * Slack-style watermark: the last timestamp up to which the user has read
     * messages in this thread. It normally advances to the latest run-finish
     * marker; marking the thread unread clears it. NULL means there is no read
     * watermark.
     */
    lastReadAt: timestamp("last_read_at"),
    /** Per-thread selected model pin. Provider routing is resolved per run. */
    selectedModel: varchar("selected_model", { length: 255 })
      .default("auto")
      .notNull(),
    /** Sparse per-model preferences copied from the member when created. */
    modelSettings: jsonb("model_settings")
      .$type<ModelSettings>()
      .default({})
      .notNull(),
    /** Per-thread Codex service tier pin. Null means standard service tier. */
    codexServiceTier: varchar("codex_service_tier", {
      length: 20,
    }).$type<CodexServiceTier>(),
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
    /** System-controlled visibility in ordinary Chat surfaces. */
    hidden: boolean("hidden").default(false).notNull(),
    /** Suppress unread indicators and user push notifications, not execution. */
    muted: boolean("muted").default(false).notNull(),
    /**
     * Timestamp at which the user manually renamed this thread.
     * NULL means the thread has never been renamed.
     * When set, automated title generation is suppressed.
     */
    renamedAt: timestamp("renamed_at"),
    /**
     * Most recent message timestamp, denormalized from chat_events.
     * Maintained app-side for direct user messages and terminal run-finished
     * markers via GREATEST() — monotonic, never rewound. Triggered user
     * messages, billing rows, and other control rows do not advance it. Powers
     * the sidebar recency and unread watermark comparisons with index-driven
     * thread queries.
     */
    lastMessageAt: timestamp("last_message_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
