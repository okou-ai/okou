import { timestamp, uuid, text, type AnyPgColumn } from "drizzle-orm/pg-core";
import { agents } from "../schema/agent";

/** Session identity and continuation columns shared by physical/runtime mappings. */
export function agentSessionColumns(conversationId: () => AnyPgColumn) {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").references(
      () => {
        return agents.id;
      },
      { onDelete: "cascade" },
    ),
    conversationId: uuid("conversation_id").references(conversationId, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
