import { check, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { AgentSuggestionEntries } from "../jsonb-contracts/agent-suggestion";

/**
 * A member's actionable suggestion collection, updated as one business value.
 * Priorities belong to items; array positions have no presentation meaning.
 * Terminal identities remain receipts so late create/update requests cannot
 * resurrect a consumed action within the 24-hour feedback window. Later writes
 * discard their draft contents; scheduled cleanup removes expired entries.
 */
export const agentSuggestions = pgTable(
  "agent_suggestions",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    entries: jsonb("entries")
      .$type<AgentSuggestionEntries>()
      .notNull()
      .default([]),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      check(
        "agent_suggestions_entries_bound",
        sql`jsonb_typeof(${table.entries}) = 'array' AND jsonb_array_length(jsonb_path_query_array(${table.entries}, '$[*] ? (@.status == "active")')) <= 10`,
      ),
    ];
  },
);
