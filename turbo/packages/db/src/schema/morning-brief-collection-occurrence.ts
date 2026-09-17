import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
import { orgMembersMetadata } from "./org-members-metadata";

/**
 * The source contract version an occurrence was admitted under.
 *
 * It is part of the occurrence's logical identity, so a collector that changes
 * what it reads or how it normalizes starts a new occurrence instead of
 * reusing a row whose frozen scope no longer describes the same work.
 */
export const MORNING_BRIEF_COLLECTION_VERSION = 1;

/** The only source this first executor collects. */
export const MORNING_BRIEF_COLLECTION_KIND_SLACK = "slack";

/**
 * What a finished attempt observed, for the scope it actually declared.
 *
 * `complete` and `partial` both produced a bundle; `partial` additionally hit a
 * documented budget or an unusable continuation, so it must never be read as a
 * complete day. `no_shared_channels` is a healthy empty read. The remaining
 * codes are failures: they are deliberately distinct from an empty read so a
 * mid-stream provider problem can never be recorded as healthy empty data.
 */
export const MORNING_BRIEF_COLLECTION_OUTCOMES = [
  "complete",
  "partial",
  "no_shared_channels",
  "rate_limited",
  "permission_denied",
  "provider_failed",
] as const;

export const MORNING_BRIEF_COLLECTION_STATUSES = [
  "running",
  "completed",
  "failed",
] as const;

/**
 * Operational ownership of one Morning Brief source collection.
 *
 * This is the state the first real collection executor consumes: it records who
 * was admitted, the scope that was frozen for them, which attempt currently
 * holds the lease, and what that attempt observed. It is metadata about a
 * collection, never a checkpoint of one. No source body, message text,
 * credential, prompt, provider payload or raw error is stored here, so a
 * completed row can report that a bundle was produced and handed to its caller
 * but can never reproduce it.
 *
 * Its lifetime is durable member ownership rather than an evictable cache. The
 * composite key to `org_members_metadata` — the source of truth for the
 * member's own preferences, including the timezone an enabled brief requires —
 * is deleted by membership, user and organization cleanup and is never refilled
 * by a background read. The Agent key covers the lifecycle deletion that
 * invalidates the installation the occurrence was admitted against. Claiming
 * and finalizing lock and recheck that member row with `FOR KEY SHARE`, so a
 * cleanup either waits for the writer and then cascades its row away, or has
 * already removed the parent and leaves nothing to write.
 *
 * This is explicit-invocation ownership only. It certifies no autonomous
 * scheduler, grants no execution permission by itself, and transfers no
 * schedule authority from the legacy automation.
 */
export const morningBriefCollectionOccurrences = pgTable(
  "morning_brief_collection_occurrences",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** The validated scheduled anchor this occurrence collects for. */
    scheduledFor: timestamp("scheduled_for").notNull(),
    /** The source this occurrence reads. Part of its logical identity. */
    collectionKind: text("collection_kind").notNull(),
    /** Must equal MORNING_BRIEF_COLLECTION_VERSION for a new occurrence. */
    collectionVersion: integer("collection_version").notNull(),

    /** Frozen at admission: `[window_start, window_end)`, retries reuse it. */
    windowStart: timestamp("window_start").notNull(),
    windowEnd: timestamp("window_end").notNull(),
    /** The member timezone pinned with the window. */
    timezone: text("timezone").notNull(),

    /** The Clerk membership generation admitted. A rejoin issues a new one. */
    membershipId: text("membership_id").notNull(),
    /** The canonical installation, schedule and Agent pinned at admission. */
    workflowId: uuid("workflow_id").notNull(),
    automationId: uuid("automation_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** The exact native Slack binding pinned at admission. */
    slackWorkspaceId: text("slack_workspace_id").notNull(),
    slackUserId: text("slack_user_id").notNull(),

    status: text("status", {
      enum: MORNING_BRIEF_COLLECTION_STATUSES,
    }).notNull(),
    /** 1 for the first admitted attempt, incremented by each re-claim. */
    attempt: integer("attempt").notNull(),
    /** Held only while `status` is `running`. */
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at"),

    outcome: text("outcome", { enum: MORNING_BRIEF_COLLECTION_OUTCOMES }),
    /** Echoed from the provider's `Retry-After`; bounds the next re-claim. */
    retryAfterSeconds: integer("retry_after_seconds"),

    /** Bounded counts describing coverage. Never message content. */
    channelCount: integer("channel_count"),
    threadCount: integer("thread_count"),
    messageCount: integer("message_count"),
    requestCount: integer("request_count"),
    /** True when a documented budget or unusable cursor bounded the read. */
    truncated: boolean("truncated"),

    claimedAt: timestamp("claimed_at").notNull(),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "morning_brief_collection_occurrences_pk",
        columns: [
          table.orgId,
          table.userId,
          table.scheduledFor,
          table.collectionKind,
          table.collectionVersion,
        ],
      }),
      foreignKey({
        name: "fk_morning_brief_collection_occurrences_member",
        columns: [table.orgId, table.userId],
        foreignColumns: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_morning_brief_collection_occurrences_agent",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      // The primary key already serves the owner and organization lookups;
      // these keep the user-wide revocation and the Agent cascade off a
      // sequential scan.
      index("idx_morning_brief_collection_occurrences_user").on(table.userId),
      index("idx_morning_brief_collection_occurrences_agent").on(table.agentId),
      check(
        "chk_morning_brief_collection_occurrence_window",
        sql`${table.windowEnd} > ${table.windowStart}`,
      ),
      check(
        "chk_morning_brief_collection_occurrence_attempt",
        sql`${table.attempt} >= 1`,
      ),
      // A lease exists exactly while an attempt is running, so no terminal row
      // can keep a token a stale worker could still match on.
      check(
        "chk_morning_brief_collection_occurrence_lease",
        sql`(${table.status} = 'running') = (${table.leaseToken} IS NOT NULL)
          AND (${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`,
      ),
      // Every terminal row carries its outcome, and a running one carries none.
      check(
        "chk_morning_brief_collection_occurrence_outcome",
        sql`(${table.status} = 'running') = (${table.outcome} IS NULL)`,
      ),
    ];
  },
);
