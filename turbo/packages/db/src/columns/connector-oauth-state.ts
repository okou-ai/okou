import {
  bigint,
  jsonb,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { StoredConnectorAccountMutation } from "@okouai/db/jsonb-contracts/connector-account-mutation";

export function connectorOauthStateColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    state: text("state").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    storageVersion: bigint("storage_version", { mode: "number" }),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id"),
    redirectUri: text("redirect_uri").notNull(),
    authorizationUrl: text("authorization_url"),
    oauthRequestedScopes: text("oauth_requested_scopes"),
    codeVerifier: text("code_verifier"),
    oauthContext: text("oauth_context"),
    accountMutation: jsonb("account_mutation")
      .$type<StoredConnectorAccountMutation>()
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
  };
}
