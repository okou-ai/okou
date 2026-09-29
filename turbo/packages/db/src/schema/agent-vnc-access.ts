import {
  index,
  pgTable,
  text,
  timestamp,
  primaryKey,
  uuid,
} from "drizzle-orm/pg-core";

import { agents } from "./agent";

export const agentVncAccess = pgTable(
  "agent_vnc_access",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return agents.id;
        },
        { onDelete: "cascade" },
      ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "agent_vnc_access_pkey",
        columns: [table.orgId, table.userId, table.agentId],
      }),
      index("idx_agent_vnc_access_agent").on(table.agentId),
      index("idx_agent_vnc_access_user").on(table.userId),
    ];
  },
);
