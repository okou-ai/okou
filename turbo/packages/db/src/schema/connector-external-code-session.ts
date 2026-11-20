import {
  boolean,
  index,
  pgTable,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { connectorExternalCodeSessionColumns } from "../columns/connector-external-code-session";

export { builtinConnectorExternalCodeSessionStatusEnum } from "../columns/connector-external-code-session";

export const builtinConnectorExternalCodeSessions = pgTable(
  "connector_external_code_sessions",
  {
    ...connectorExternalCodeSessionColumns(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_connector_external_code_sessions_token").on(
        table.sessionTokenHash,
      ),
      index("idx_connector_external_code_sessions_owner_slug_status").on(
        table.orgId,
        table.userId,
        table.connectorSlug,
        table.authMethod,
        table.status,
      ),
      index("idx_connector_external_code_sessions_expiration").on(
        table.status,
        table.expiresAt,
      ),
    ];
  },
);
