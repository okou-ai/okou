import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { connectors } from "./connector";
import { orgCustomConnectorDcrRegistrations } from "./org-custom-connector-dcr-registration";

export type CustomConnectorAccountOAuthRegistrationMethod = "cimd" | "dcr";
export type CustomConnectorAccountOAuthTokenEndpointAuthMethod =
  "none" | "client_secret_basic" | "client_secret_post";

/**
 * Normalized Automatic OAuth authority and client binding for one custom
 * connector account. Tokens remain in the ordinary connector secret rows.
 */
export const customConnectorAccountOauthBindings = pgTable(
  "custom_connector_account_oauth_bindings",
  {
    connectorAccountId: uuid("connector_account_id").primaryKey(),
    customConnectorId: uuid("custom_connector_id").notNull(),
    issuer: text("issuer").notNull(),
    resource: text("resource").notNull(),
    resourceMetadataUrl: text("resource_metadata_url"),
    tokenEndpoint: text("token_endpoint").notNull(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .$type<CustomConnectorAccountOAuthTokenEndpointAuthMethod>()
      .notNull(),
    registrationMethod: varchar("registration_method", { length: 8 })
      .$type<CustomConnectorAccountOAuthRegistrationMethod>()
      .notNull(),
    dcrRegistrationId: uuid("dcr_registration_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_custom_connector_account_oauth_bindings_account",
        columns: [table.connectorAccountId, table.customConnectorId],
        foreignColumns: [connectors.id, connectors.customConnectorId],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_custom_connector_account_oauth_bindings_dcr_registration",
        columns: [table.dcrRegistrationId, table.customConnectorId],
        foreignColumns: [
          orgCustomConnectorDcrRegistrations.id,
          orgCustomConnectorDcrRegistrations.customConnectorId,
        ],
      }),
      index("idx_custom_connector_account_oauth_bindings_connector").on(
        table.customConnectorId,
      ),
      index("idx_custom_connector_account_oauth_bindings_dcr").on(
        table.dcrRegistrationId,
      ),
      check(
        "chk_custom_connector_account_oauth_binding_identity",
        sql`(
          btrim(${table.issuer}) <> ''
          AND btrim(${table.resource}) <> ''
          AND btrim(${table.tokenEndpoint}) <> ''
          AND btrim(${table.clientId}) <> ''
          AND (
            ${table.resourceMetadataUrl} IS NULL
            OR btrim(${table.resourceMetadataUrl}) <> ''
          )
        )`,
      ),
      check(
        "chk_custom_connector_account_oauth_binding_token_auth_method",
        sql`${table.tokenEndpointAuthMethod} IN (
          'none',
          'client_secret_basic',
          'client_secret_post'
        )`,
      ),
      check(
        "chk_custom_connector_account_oauth_binding_registration",
        sql`(
          (
            ${table.registrationMethod} = 'cimd'
            AND ${table.dcrRegistrationId} IS NULL
            AND ${table.tokenEndpointAuthMethod} = 'none'
          ) OR (
            ${table.registrationMethod} = 'dcr'
            AND ${table.dcrRegistrationId} IS NOT NULL
          )
        )`,
      ),
    ];
  },
);
