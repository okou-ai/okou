import {
  boolean,
  index,
  pgTable,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { connectorOauthDeviceAuthorizationSessionColumns } from "../columns/connector-oauth-device-authorization-session";

export { builtinConnectorOauthDeviceAuthorizationSessionStatusEnum } from "../columns/connector-oauth-device-authorization-session";

export const builtinConnectorOauthDeviceAuthorizationSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  {
    ...connectorOauthDeviceAuthorizationSessionColumns(),
    agentId: uuid("agent_id"),
    authorizeAgent: boolean("authorize_agent").default(false).notNull(),
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
