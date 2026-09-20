import {
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { agents } from "./agent";

/**
 * Unscoped historical preferences retained for outgoing API versions.
 * Their platform cannot be inferred; current dispatch uses the scoped table.
 */
export const feishuUserAgentPreferences = pgTable(
  "feishu_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    selectedAgentId: uuid("selected_agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.userId, table.orgId] })];
  },
);

/** A missing preference or null Agent selects that platform's installation default. */
export const feishuPlatformUserAgentPreferences = pgTable(
  "feishu_platform_user_agent_preferences",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    platform: varchar("platform", {
      length: 16,
      enum: ["feishu", "lark"],
    }).notNull(),
    selectedAgentId: uuid("selected_agent_id").references(
      () => {
        return agents.id;
      },
      {
        onDelete: "set null",
      },
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "feishu_platform_user_agent_preferences_pk",
        columns: [table.userId, table.orgId, table.platform],
      }),
      check(
        "chk_feishu_platform_user_agent_preferences_platform",
        sql`${table.platform} IN ('feishu', 'lark')`,
      ),
    ];
  },
);
