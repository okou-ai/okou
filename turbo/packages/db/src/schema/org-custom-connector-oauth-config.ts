import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { OrgCustomConnectorOAuthAuthorizationParams } from "@okouai/db/jsonb-contracts/org-custom-connector-oauth-config";

import { orgCustomConnectors } from "./org-custom-connector";

export type OrgCustomConnectorOAuthProviderAdapter = "standard" | "feishu";
export type OrgCustomConnectorOAuthPkceMethod = "none" | "S256";
export type OrgCustomConnectorOAuthTokenEndpointAuthMethod =
  "client_secret_basic" | "client_secret_post";

/**
 * Organization-owned OAuth application configuration for a custom connector.
 *
 * The client ID is public OAuth metadata. The client secret uses the stored
 * secret encryption envelope. Per-user tokens never live in this table.
 */
export const orgCustomConnectorOauthConfigs = pgTable(
  "org_custom_connector_oauth_configs",
  {
    connectorId: uuid("connector_id").primaryKey(),
    orgId: text("org_id").notNull(),
    providerAdapter: varchar("provider_adapter", { length: 32 })
      .$type<OrgCustomConnectorOAuthProviderAdapter>()
      .notNull(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    encryptedClientSecret: text("encrypted_client_secret").notNull(),
    authorizationUrl: text("authorization_url").notNull(),
    tokenUrl: text("token_url").notNull(),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .$type<OrgCustomConnectorOAuthTokenEndpointAuthMethod>()
      .notNull(),
    pkceMethod: varchar("pkce_method", { length: 8 })
      .$type<OrgCustomConnectorOAuthPkceMethod>()
      .notNull(),
    scopes: text("scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    authorizationParams: jsonb("authorization_params")
      .$type<OrgCustomConnectorOAuthAuthorizationParams>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_org_custom_connector_oauth_configs_connector",
        columns: [table.connectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_org_custom_connector_oauth_configs_provider_adapter",
        sql`${table.providerAdapter} IN ('standard', 'feishu')`,
      ),
      check(
        "chk_org_custom_connector_oauth_configs_pkce_method",
        sql`${table.pkceMethod} IN ('none', 'S256')`,
      ),
      check(
        "chk_org_custom_connector_oauth_configs_token_auth_method",
        sql`${table.tokenEndpointAuthMethod} IN (
          'client_secret_basic',
          'client_secret_post'
        )`,
      ),
    ];
  },
);
