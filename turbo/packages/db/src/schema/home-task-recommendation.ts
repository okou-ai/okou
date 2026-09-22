import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { HomeTaskRecommendationEntries } from "@okouai/db/jsonb-contracts/home-task-recommendation";
import { agents } from "./agent";

/**
 * The cached home page task recommendations for one Agent shown to one member.
 *
 * One row per (user, org, Agent): the cards are derived only from that Agent's
 * visible threads and the Gmail content it is allowed to read. A second Agent
 * or workspace therefore never reuses the first one's suggestions. The row is
 * a cache, not a record — every refresh
 * replaces `entries` wholesale and nothing else references it, which is why the
 * table has no surrogate key and no history.
 *
 * `nextRefreshAt` and `lastRequestedAt` are the refresh authorities. Overlapping
 * cron invocations may select the same active row, but the claim columns decide
 * which one may spend a provider call; every user request only reads the cache.
 */
export const homeTaskRecommendations = pgTable(
  "home_task_recommendations",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agents.id;
        },
        { onDelete: "cascade" },
      ),
    entries: jsonb("entries")
      .$type<HomeTaskRecommendationEntries>()
      .notNull()
      .default([]),
    /**
     * When `entries` was produced. NULL means a row exists to carry a claim or
     * a cooldown but has never held a usable set.
     */
    generatedAt: timestamp("generated_at"),
    /**
     * Digest of the evidence the last accepted generation read. An unchanged
     * digest is why a refresh can return the same cards without paying for a
     * second identical generation.
     */
    inputDigest: text("input_digest"),
    nextRefreshAt: timestamp("next_refresh_at").notNull().defaultNow(),
    /**
     * Last time a home page asked to display this Agent's cards. The cron only
     * refreshes recently requested scopes, so one visit cannot create an
     * unbounded background workload.
     */
    lastRequestedAt: timestamp("last_requested_at").notNull().defaultNow(),
    claimId: uuid("claim_id"),
    claimExpiresAt: timestamp("claim_expires_at"),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.userId, table.orgId, table.agentId] }),
      index("home_task_recommendations_refresh_idx").on(
        table.nextRefreshAt,
        table.lastRequestedAt,
      ),
      check(
        "home_task_recommendations_entries_bound",
        sql`jsonb_typeof(${table.entries}) = 'array' AND jsonb_array_length(${table.entries}) <= 3 AND octet_length(${table.entries}::text) <= 8192`,
      ),
    ];
  },
);
