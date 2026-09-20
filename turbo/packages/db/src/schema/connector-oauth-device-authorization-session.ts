import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StoredConnectorAccountMutation } from "@okouai/db/jsonb-contracts/connector-account-mutation";

export const builtinConnectorOauthDeviceAuthorizationSessionStatusEnum = pgEnum(
  "connector_oauth_device_authorization_session_status",
  [
    "awaiting_user_authorization",
    "polling",
    "complete",
    "denied",
    "expired",
    "error",
  ],
);

export const builtinConnectorOauthDeviceAuthorizationSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    status: builtinConnectorOauthDeviceAuthorizationSessionStatusEnum("status")
      .default("awaiting_user_authorization")
      .notNull(),
    sessionTokenHash: varchar("session_token_hash", { length: 128 }).notNull(),
    encryptedProviderState: text("encrypted_provider_state").notNull(),
    accountMutation: jsonb("account_mutation")
      .$type<StoredConnectorAccountMutation>()
      .notNull(),
    completedConnectorId: uuid("completed_connector_id"),
    oauthRequestedScopes: text("oauth_requested_scopes"),
    userCode: varchar("user_code", { length: 255 }).notNull(),
    verificationUri: text("verification_uri").notNull(),
    verificationUriComplete: text("verification_uri_complete"),
    intervalSeconds: integer("interval_seconds").notNull(),
    errorCode: varchar("error_code", { length: 255 }),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_oauth_device_authorization_sessions_token").on(
        table.sessionTokenHash,
      ),
      index("idx_connector_oauth_device_sessions_owner_slug_status").on(
        table.orgId,
        table.userId,
        table.connectorSlug,
        table.authMethod,
        table.status,
      ),
      index("idx_connector_oauth_device_authorization_sessions_expiration").on(
        table.status,
        table.expiresAt,
      ),
    ];
  },
);
