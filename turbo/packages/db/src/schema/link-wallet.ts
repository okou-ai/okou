import { sql } from "drizzle-orm";

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

import { chatThreads } from "./chat-thread";

export const linkWalletConnections = pgTable(
  "link_wallet_connections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // Retired connections remain linked to historical spends for reconciliation.
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    // Identifies the actual OAuth authorization, not a refresh coordination lease.
    authorizationId: uuid("authorization_id").notNull(),
    // The authorization request snapshot, preserved across token refreshes.
    oauthRequestedScopes: text("oauth_requested_scopes"),
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
      uniqueIndex("idx_link_wallet_connections_owner")
        .on(table.orgId, table.userId)
        .where(sql`${table.retiredAt} IS NULL`),
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
    // Old API writers retain agent consent during a rolling deployment.
    scope: varchar("scope", { length: 16 })
      .$type<"agent" | "workspace_user">()
      .notNull()
      .default("agent"),
    oauthRequestedScopes: text("oauth_requested_scopes"),
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
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => {
        return linkWalletConnections.id;
      }),
    authorizationId: uuid("authorization_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    // The originating chat guards credential retrieval; legacy rows can be null.
    // Only approvals eligible for automatic continuation have an approval run.
    approvalThreadId: uuid("approval_thread_id").references(
      () => {
        return chatThreads.id;
      },
      {
        onDelete: "set null",
      },
    ),
    approvalRunId: uuid("approval_run_id"),
    providerSpendId: varchar("provider_spend_id", { length: 256 }),
    amount: integer("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    merchantName: text("merchant_name").notNull(),
    merchantUrl: text("merchant_url").notNull(),
    context: text("context").notNull(),
    test: boolean("test").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("creating"),
    approvalUrl: text("approval_url"),
    // Provider business state needed to distinguish resumable actions in cards.
    actionResolution: varchar("action_resolution", { length: 64 }),
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
        table.intentId,
      ),
      uniqueIndex("idx_link_wallet_spends_provider").on(table.providerSpendId),
      index("idx_link_wallet_spends_approval_deadline")
        .on(table.expiresAt, table.id)
        .where(sql`${table.approvalThreadId} IS NOT NULL`),
    ];
  },
);
