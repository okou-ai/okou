import { pgTable } from "drizzle-orm/pg-core";
import { connectorOauthDeviceAuthorizationSessionColumns } from "../columns/connector-oauth-device-authorization-session";

/** Application mapping for member-owned connector authorization sessions. */
export const builtinConnectorOauthDeviceAuthorizationSessions = pgTable(
  "connector_oauth_device_authorization_sessions",
  connectorOauthDeviceAuthorizationSessionColumns(),
);
