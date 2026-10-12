import {
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

// Frozen column list from canonical API 1.727.8, before #39379 preparation.
// Retain until #39380's physical contraction is deployed and accepted.
export const outgoingSshConnections = pgTable("ssh_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  displayName: varchar("display_name", { length: 128 }).notNull(),
  host: varchar("host", { length: 253 }).notNull(),
  port: integer("port").notNull().default(22),
  credentialId: uuid("credential_id").notNull(),
  cloudflareAccessId: uuid("cloudflare_access_id"),
  tailscaleId: uuid("tailscale_id"),
  transport: text("transport", {
    enum: ["direct", "cloudflare_access", "tailscale"],
  }).notNull(),
  legacyNeedsRebind: boolean("needs_rebind").default(false).notNull(),
  learnedHostKeyAlgorithm: varchar("learned_host_key_algorithm", {
    length: 64,
  }),
  learnedHostKeyFingerprint: varchar("learned_host_key_fingerprint", {
    length: 64,
  }),
  generation: integer("generation").notNull().default(1),
  defaultEnabledForChats: boolean("default_enabled_for_chats")
    .notNull()
    .default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
