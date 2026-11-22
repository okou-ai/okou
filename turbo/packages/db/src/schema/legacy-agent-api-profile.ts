import type { ContentBundle } from "../jsonb-contracts/content-bundle";
import {
  index,
  pgTable,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type AgentVisibility = "public" | "private";

/** Retained solely for old Agent HTTP clients during the mobile upgrade window. */
export const legacyAgentApiProfiles = pgTable(
  "legacy_agent_api_profiles",
  {
    id: uuid("id").primaryKey(),
    orgId: text("org_id").notNull(),
    owner: text("owner").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<AgentVisibility>()
      .notNull()
      .default("public"),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    instructions: text("instructions").notNull().default(""),
    // NULL is unconverted; publication writes text and bundle together.
    instructionsBundle: jsonb("instructions_bundle").$type<ContentBundle>(),
    sound: varchar("sound", { length: 64 }),
    avatarUrl: varchar("avatar_url", { length: 1024 }),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      workspace: index("idx_legacy_agent_api_workspace").on(table.orgId),
      workspaceName: uniqueIndex("uq_legacy_agent_api_workspace_name").on(
        table.orgId,
        table.name,
      ),
    };
  },
);
