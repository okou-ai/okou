import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { modelProviders } from "./model-provider";

export type AgentVisibility = "public" | "private";

/**
 * Canonical product Agent identity and presentation state.
 *
 * Production readers and writers use this table and its canonical references.
 */
export const agents = pgTable(
  "agents",
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
    sound: varchar("sound", { length: 64 }),
    avatarUrl: varchar("avatar_url", { length: 1024 }),
    modelProviderId: uuid("model_provider_id").references(
      () => {
        return modelProviders.id;
      },
      { onDelete: "set null" },
    ),
    selectedModel: varchar("selected_model", { length: 255 }),
    preferPersonalProvider: boolean("prefer_personal_provider")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      orgNameIdx: uniqueIndex("idx_agents_org_name").on(
        table.orgId,
        table.name,
      ),
      orgIdx: index("idx_agents_org").on(table.orgId),
      ownerReference: unique("idx_agents_id_org_owner").on(
        table.id,
        table.orgId,
        table.owner,
      ),
    };
  },
);
