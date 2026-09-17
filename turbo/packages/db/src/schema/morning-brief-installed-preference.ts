import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agent";
import { chatThreads } from "./chat-thread";
import { orgMembersCache } from "./org-members-cache";

/**
 * The comparison contract version of the copied fields below.
 *
 * A reader accepts a row only when it carries the version it understands, so an
 * older binary's row shape can never be reinterpreted by a newer field set.
 */
export const MORNING_BRIEF_PREFERENCE_PROJECTION_VERSION = 1;

/**
 * A disposable projection of the Morning Brief state a member already owns.
 *
 * It is a serialization rehearsal for `simple-morning-brief`, never an
 * authority: the legacy installation and its automation still decide what the
 * brief does. Every field here is copied from that live state and is only
 * usable while it still matches it, so this table carries no source bodies,
 * prompts, results, credentials, usage or delivery attempts.
 *
 * Its lifetime is deliberately an evictable cache. The composite foreign key to
 * `org_members_cache` fences the current local membership, user and
 * organization deletion paths; the Agent and thread keys fence the two
 * lifecycle deletions that invalidate a brief's destination. Before native
 * state becomes execution authority, that cache lifetime must be replaced with
 * durable membership and erasure ownership.
 */
export const morningBriefInstalledPreferences = pgTable(
  "morning_brief_installed_preferences",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Must equal MORNING_BRIEF_PREFERENCE_PROJECTION_VERSION to be read. */
    projectionVersion: integer("projection_version").notNull(),
    /** The installation the preference surface managed when this was written. */
    workflowId: uuid("workflow_id").notNull(),
    /** The schedule that owned the copied enabled state. */
    automationId: uuid("automation_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** Null before the first delivery creates the thread, which is normal. */
    chatThreadId: uuid("chat_thread_id"),
    enabled: boolean("enabled").notNull(),
    cronExpression: text("cron_expression"),
    timezone: text("timezone").notNull(),
    nextRunAt: timestamp("next_run_at"),
    /** When this copy was written. Never evidence that the source is unchanged. */
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_installed_preferences_pk",
        columns: [table.orgId, table.userId],
      }),
      foreignKey({
        name: "fk_morning_brief_installed_preferences_member",
        columns: [table.orgId, table.userId],
        foreignColumns: [orgMembersCache.orgId, orgMembersCache.userId],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_morning_brief_installed_preferences_agent",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_morning_brief_installed_preferences_thread",
        columns: [table.chatThreadId],
        foreignColumns: [chatThreads.id],
      }).onDelete("cascade"),
      // The primary key already serves org-wide and owner lookups; these keep
      // the user-wide path and both cascade deletions off a sequential scan.
      index("idx_morning_brief_installed_preferences_user").on(table.userId),
      index("idx_morning_brief_installed_preferences_agent").on(table.agentId),
      index("idx_morning_brief_installed_preferences_thread").on(
        table.chatThreadId,
      ),
    ];
  },
);
