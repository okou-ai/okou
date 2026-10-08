import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const modelProviderAuthSessionStatusEnum = pgEnum(
  "model_provider_auth_session_status",
  [
    "initializing",
    "awaiting_user_approval",
    "completing",
    "imported",
    "expired",
    "cancelled",
    "error",
  ],
);

export const modelProviderAuthSessions = pgTable(
  "model_provider_auth_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorType: varchar("connector_type", { length: 50 }).notNull(),
    source: varchar("source", { length: 50 }).notNull(),
    status: modelProviderAuthSessionStatusEnum("status")
      .default("initializing")
      .notNull(),
    approvalUrl: text("approval_url"),
    verificationCode: varchar("verification_code", { length: 128 }),
    encryptedProviderState: text("encrypted_provider_state"),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
    cancelledAt: timestamp("cancelled_at"),
  },
  (table) => {
    return [
      index("idx_model_provider_auth_sessions_owner_status").on(
        table.orgId,
        table.userId,
        table.connectorType,
        table.source,
        table.status,
      ),
      index("idx_model_provider_auth_sessions_expiration").on(
        table.status,
        table.expiresAt,
      ),
    ];
  },
);
