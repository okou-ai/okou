import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Organization-scoped client registration for one exact builtin MCP contract. */
export const builtinConnectorDcrRegistrations = pgTable(
  "connector_dcr_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    contractHash: varchar("contract_hash", { length: 64 }).notNull(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    encryptedClientSecret: text("encrypted_client_secret"),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .$type<"none" | "client_secret_basic" | "client_secret_post">()
      .notNull(),
    registeredScopes: text("registered_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    redirectUri: text("redirect_uri").notNull(),
    issuedAt: timestamp("issued_at").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_connector_dcr_owner").on(
        table.id,
        table.orgId,
        table.connectorSlug,
        table.authMethod,
        table.contractHash,
      ),
      unique("uq_connector_dcr_issuer").on(
        table.orgId,
        table.connectorSlug,
        table.authMethod,
        table.contractHash,
        table.issuer,
      ),
      index("idx_connector_dcr_org").on(table.orgId),
      check(
        "chk_connector_dcr_identity",
        sql`btrim(${table.issuer}) <> '' AND btrim(${table.clientId}) <> '' AND btrim(${table.redirectUri}) <> '' AND ${table.contractHash} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        "chk_connector_dcr_client_auth",
        sql`(${table.tokenEndpointAuthMethod} = 'none' AND ${table.encryptedClientSecret} IS NULL) OR (${table.tokenEndpointAuthMethod} IN ('client_secret_basic', 'client_secret_post') AND ${table.encryptedClientSecret} IS NOT NULL)`,
      ),
      check(
        "chk_connector_dcr_expiry",
        sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.issuedAt}`,
      ),
    ];
  },
);
