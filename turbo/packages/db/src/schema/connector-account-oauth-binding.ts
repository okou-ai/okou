import { sql } from "drizzle-orm";
import {
  bigint,
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
import { builtinConnectorDcrRegistrations } from "./connector-dcr-registration";

/** Authority and client frozen at builtin Automatic consent; tokens remain account-owned secrets. */
export const builtinConnectorAccountOauthBindings = pgTable(
  "connector_account_oauth_bindings",
  {
    connectorAccountId: uuid("connector_account_id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    connectorSlug: varchar("connector_slug", { length: 64 }).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(),
    storageVersion: bigint("storage_version", { mode: "number" }).notNull(),
    contractHash: varchar("contract_hash", { length: 64 }).notNull(),
    endpoint: text("endpoint").notNull(),
    issuer: text("issuer").notNull(),
    resource: text("resource").notNull(),
    resourceMetadataUrl: text("resource_metadata_url"),
    tokenEndpoint: text("token_endpoint").notNull(),
    clientId: text("client_id").notNull(),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", {
      length: 32,
    })
      .$type<"none" | "client_secret_basic" | "client_secret_post">()
      .notNull(),
    registrationMethod: varchar("registration_method", { length: 8 })
      .$type<"cimd" | "dcr">()
      .notNull(),
    dcrRegistrationId: uuid("dcr_registration_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      foreignKey({
        name: "fk_connector_oauth_binding_account",
        columns: [table.connectorAccountId, table.connectorSlug],
        foreignColumns: [connectors.id, connectors.connectorSlug],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_connector_oauth_binding_account_owner",
        columns: [table.connectorAccountId, table.orgId, table.userId],
        foreignColumns: [connectors.id, connectors.orgId, connectors.userId],
      }).onDelete("cascade"),
      foreignKey({
        name: "fk_connector_oauth_binding_dcr_owner",
        columns: [
          table.dcrRegistrationId,
          table.orgId,
          table.connectorSlug,
          table.authMethod,
          table.contractHash,
        ],
        foreignColumns: [
          builtinConnectorDcrRegistrations.id,
          builtinConnectorDcrRegistrations.orgId,
          builtinConnectorDcrRegistrations.connectorSlug,
          builtinConnectorDcrRegistrations.authMethod,
          builtinConnectorDcrRegistrations.contractHash,
        ],
      }),
      index("idx_connector_oauth_binding_dcr").on(table.dcrRegistrationId),
      check(
        "chk_connector_oauth_binding_identity",
        sql`${table.storageVersion} > 0 AND ${table.contractHash} ~ '^[a-f0-9]{64}$' AND btrim(${table.endpoint}) <> '' AND btrim(${table.issuer}) <> '' AND btrim(${table.resource}) <> '' AND btrim(${table.tokenEndpoint}) <> '' AND btrim(${table.clientId}) <> ''`,
      ),
      check(
        "chk_connector_oauth_binding_token_auth",
        sql`${table.tokenEndpointAuthMethod} IN ('none', 'client_secret_basic', 'client_secret_post')`,
      ),
      check(
        "chk_connector_oauth_binding_registration",
        sql`(${table.registrationMethod} = 'cimd' AND ${table.dcrRegistrationId} IS NULL AND ${table.tokenEndpointAuthMethod} = 'none') OR (${table.registrationMethod} = 'dcr' AND ${table.dcrRegistrationId} IS NOT NULL)`,
      ),
    ];
  },
);
