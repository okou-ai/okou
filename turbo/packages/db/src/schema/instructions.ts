import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ContentBundle } from "../jsonb-contracts/content-bundle";

/** Retained personal content; membership preferences may be removed on departure. */
export const instructions = pgTable(
  "instructions",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    bundle: jsonb("bundle").$type<ContentBundle>().notNull(),
    version: uuid("version").notNull().defaultRandom(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({ columns: [table.orgId, table.userId] }),
      index("idx_instructions_user").on(table.userId),
    ];
  },
);
