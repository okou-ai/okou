import { SSH_CONNECTION_MODES } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  boolean,
  integer,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export function sshConnectionColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    displayName: varchar("display_name", { length: 128 }).notNull(),
    host: varchar("host", { length: 253 }).notNull(),
    port: integer("port").notNull().default(22),
    credentialId: uuid("credential_id"),
    cloudflareAccessId: uuid("cloudflare_access_id"),
    tailscaleId: uuid("tailscale_id"),
    // Keep the existing SQL column name for the complete connection mode.
    connectionMode: text("transport", { enum: SSH_CONNECTION_MODES }).notNull(),
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
    tailscaleSshUsername: varchar("tailscale_ssh_username", { length: 255 }),
  };
}
