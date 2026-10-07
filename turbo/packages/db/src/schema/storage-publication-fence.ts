import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * One generation per Agent-wide (`@agent`) or user scope. Reserving a storage
 * publication advances it; the row also serializes publishers of that scope.
 */
export const storagePublicationGenerations = pgTable(
  "storage_publication_generations",
  {
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    subject: text("subject").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull().default(1),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "storage_publication_generations_pk",
        columns: [table.orgId, table.agentId, table.subject],
      }),
      check(
        "storage_publication_generations_generation_check",
        sql`${table.generation} > 0`,
      ),
    ];
  },
);

/**
 * The newest reservation token per publication key. A newer reservation of the
 * same key replaces it, so an older, slower publisher can no longer commit.
 */
export const storagePublicationTokens = pgTable(
  "storage_publication_tokens",
  {
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    subject: text("subject").notNull(),
    publicationKey: text("publication_key").notNull(),
    generation: bigint("generation", { mode: "number" }).notNull(),
    token: uuid("token").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "storage_publication_tokens_pk",
        columns: [
          table.orgId,
          table.agentId,
          table.subject,
          table.publicationKey,
        ],
      }),
      uniqueIndex("storage_publication_tokens_token_idx").on(table.token),
      check(
        "storage_publication_tokens_generation_check",
        sql`${table.generation} > 0`,
      ),
    ];
  },
);
