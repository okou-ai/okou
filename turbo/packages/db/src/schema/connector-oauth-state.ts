import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { connectorOauthStateColumns } from "../columns/connector-oauth-state";
import { orgCustomConnectors } from "./org-custom-connector";
import { connectors } from "./connector";

export const connectorOauthCompletions = pgTable(
  "connector_oauth_completions",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(
        () => {
          return connectors.id;
        },
        { onDelete: "cascade" },
      ),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (table) => {
    return [
      index("idx_connector_oauth_completions_expires_at").on(table.expiresAt),
    ];
  },
);

export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  {
    ...connectorOauthStateColumns(),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_oauth_states_state").on(table.state),
      index("idx_connector_oauth_states_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_connector_oauth_states_expires_at").on(table.expiresAt),
      foreignKey({
        name: "fk_connector_oauth_states_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_connector_oauth_states_identity",
        sql`num_nonnulls(${table.connectorSlug}, ${table.customConnectorId}) = 1`,
      ),
      check(
        "chk_connector_oauth_states_custom_storage_version",
        sql`(
          ${table.customConnectorId} IS NULL
          AND ${table.storageVersion} IS NULL
        ) OR (
          ${table.customConnectorId} IS NOT NULL
          AND (
            ${table.storageVersion} IS NULL
            OR ${table.storageVersion} > 0
          )
        )`,
      ),
    ];
  },
);
