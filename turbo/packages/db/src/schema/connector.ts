import {
  bigint,
  check,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  unique,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Connectors table
 * Stores metadata for connected third-party services (GitHub, etc.)
 * Actual secrets stored in secrets table with type="connector"
 * A connection belongs to either one built-in connector slug or one
 * organization-defined custom connector.
 */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    displayName: varchar("display_name", { length: 255 }),
    isDefault: boolean("is_default").default(true).notNull(),
    authMethod: varchar("auth_method", { length: 50 }).notNull(), // "oauth"
    // Builtin Automatic keeps the catalog method ID and records its resolution separately.
    automaticAuthType: varchar("automatic_auth_type", { length: 8 }).$type<
      "none" | "oauth"
    >(),
    storageVersion: bigint("storage_version", { mode: "number" }).notNull(),

    // External account info (from OAuth)
    externalId: varchar("external_id", { length: 255 }),
    externalUsername: varchar("external_username", { length: 255 }),
    externalEmail: varchar("external_email", { length: 255 }),
    oauthScopes: text("oauth_scopes"), // Custom grants; legacy built-in fact and requested mirror for new built-in writes
    oauthGrantedScopes: text("oauth_granted_scopes"), // JSON array of effective built-in OAuth grants
    tokenExpiresAt: timestamp("token_expires_at"), // null = unknown; refreshable OAuth connectors auto-refresh on next use to backfill
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),

    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    reconnectReason: varchar("reconnect_reason", { length: 64 }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_connectors_org").on(table.orgId),
      index("idx_connectors_stripe_oauth_external_id")
        .on(table.externalId)
        .where(
          sql`${table.connectorSlug} = 'stripe' AND ${table.authMethod} = 'oauth'`,
        ),
      index("idx_connectors_org_user_custom_connector")
        .on(
          table.orgId,
          table.userId,
          table.customConnectorId,
          table.createdAt,
          table.id,
        )
        .where(sql`${table.customConnectorId} IS NOT NULL`),
      uniqueIndex("idx_connectors_org_user_custom_connector_default")
        .on(table.orgId, table.userId, table.customConnectorId)
        .where(
          sql`${table.customConnectorId} IS NOT NULL AND ${table.isDefault} = true`,
        ),
      unique("idx_connectors_id_org_user").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      unique("idx_connectors_id_slug").on(table.id, table.connectorSlug),
      unique("idx_connectors_id_custom_connector").on(
        table.id,
        table.customConnectorId,
      ),
      foreignKey({
        name: "fk_connectors_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_connectors_identity",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
      index("idx_connectors_org_user_slug")
        .on(
          table.orgId,
          table.userId,
          table.connectorSlug,
          table.createdAt,
          table.id,
        )
        .where(sql`${table.connectorSlug} IS NOT NULL`),
      uniqueIndex("idx_connectors_org_user_slug_default")
        .on(table.orgId, table.userId, table.connectorSlug)
        .where(
          sql`${table.connectorSlug} IS NOT NULL AND ${table.isDefault} = true`,
        ),
      check(
        "chk_connectors_storage_version_positive",
        sql`${table.storageVersion} > 0`,
      ),
      check(
        "chk_connectors_automatic_auth_type",
        sql`${table.automaticAuthType} IS NULL OR (
          ${table.connectorSlug} IS NOT NULL
          AND ${table.automaticAuthType} IN ('none', 'oauth')
          AND (${table.automaticAuthType} <> 'none' OR ${table.tokenExpiresAt} IS NULL)
        )`,
      ),
    ];
  },
);
