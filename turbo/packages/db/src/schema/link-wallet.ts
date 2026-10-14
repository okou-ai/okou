import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { agents } from "./agent";

export const linkWalletConnections = pgTable(
  "link_wallet_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    // Identifies the actual OAuth authorization, not a refresh coordination lease.
    authorizationId: uuid("authorization_id").notNull(),
    encryptedCredentials: text("encrypted_credentials"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationConfirmedAt: timestamp("revocation_confirmed_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_link_wallet_connections_owner_agent").on(
        table.orgId,
        table.userId,
        table.agentId,
      ),
    ];
  },
);

export const linkWalletOAuthAttempts = pgTable(
  "link_wallet_oauth_attempts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    stateHash: text("state_hash").notNull(),
    status: varchar("status", { length: 16 })
      .$type<"pending" | "exchanging" | "completed" | "failed">()
      .notNull()
      .default("pending"),
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
    encryptedVerifier: text("encrypted_verifier").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_link_wallet_oauth_state").on(table.stateHash),
      index("idx_link_wallet_oauth_expiry").on(table.expiresAt),
    ];
  },
);

export const linkWalletSpends = pgTable(
  "link_wallet_spends",
  {
    id: uuid("id").defaultRandom().primaryKey(),
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => {
        return linkWalletConnections.id;
      }),
    authorizationId: uuid("authorization_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    providerSpendId: varchar("provider_spend_id", { length: 256 }),
    amount: integer("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    merchantName: text("merchant_name").notNull(),
    merchantUrl: text("merchant_url").notNull(),
    context: text("context").notNull(),
    test: boolean("test").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("creating"),
    approvalUrl: text("approval_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_link_wallet_spends_intent").on(
        table.orgId,
        table.userId,
        table.agentId,
        table.intentId,
      ),
      uniqueIndex("idx_link_wallet_spends_provider").on(table.providerSpendId),
    ];
  },
);
