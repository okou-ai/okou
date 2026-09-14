import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";

export const agentCloudflareAccess = pgTable(
  "agent_cloudflare_access",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "agent_cloudflare_access_pkey",
        columns: [table.orgId, table.userId, table.agentId],
      }),
      foreignKey({
        name: "agent_cloudflare_access_agent_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      index("idx_agent_cloudflare_access_agent").on(table.agentId),
    ];
  },
);
