import {
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Private project identity. Thread membership remains on chat_threads. */
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("projects_id_user_unique").on(table.id, table.userId),
      index("projects_user_org_created_idx").on(
        table.userId,
        table.orgId,
        table.createdAt,
        table.id,
      ),
    ];
  },
);
