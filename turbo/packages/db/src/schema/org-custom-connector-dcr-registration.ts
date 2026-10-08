import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { orgCustomConnectors } from "./org-custom-connector";

export type OrgCustomConnectorDcrTokenEndpointAuthMethod =
  "none" | "client_secret_basic" | "client_secret_post";

/**
 * Organization-owned OAuth Dynamic Client Registration result shared by
 * accounts connecting the same custom connector to the same issuer.
 */
export const orgCustomConnectorDcrRegistrations = pgTable(
  "org_custom_connector_dcr_registrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    customConnectorId: uuid("custom_connector_id").notNull(),
    issuer: text("issuer").notNull(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    encryptedClientSecret: text("encrypted_client_secret"),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .$type<OrgCustomConnectorDcrTokenEndpointAuthMethod>()
      .notNull(),
    registeredScopes: text("registered_scopes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    redirectUri: text("redirect_uri").notNull(),
    issuedAt: timestamp("issued_at").notNull(),
    expiresAt: timestamp("expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_org_custom_connector_dcr_registrations_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      unique("uq_org_custom_connector_dcr_registration_id_connector").on(
        table.id,
        table.customConnectorId,
      ),
      unique("uq_org_custom_connector_dcr_registration_issuer").on(
        table.customConnectorId,
        table.issuer,
      ),
      index("idx_org_custom_connector_dcr_registrations_org").on(table.orgId),
      check(
        "chk_org_custom_connector_dcr_registration_identity",
        sql`(
          btrim(${table.issuer}) <> ''
          AND btrim(${table.clientId}) <> ''
          AND btrim(${table.redirectUri}) <> ''
        )`,
      ),
      check(
        "chk_org_custom_connector_dcr_registration_token_auth_method",
        sql`(
          (
            ${table.tokenEndpointAuthMethod} = 'none'
            AND ${table.encryptedClientSecret} IS NULL
          ) OR (
            ${table.tokenEndpointAuthMethod} IN (
              'client_secret_basic',
              'client_secret_post'
            )
            AND ${table.encryptedClientSecret} IS NOT NULL
          )
        )`,
      ),
      check(
        "chk_org_custom_connector_dcr_registration_expiry",
        sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.issuedAt}`,
      ),
    ];
  },
);
