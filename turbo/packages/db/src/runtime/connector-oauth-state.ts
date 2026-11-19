import { pgTable } from "drizzle-orm/pg-core";
import { connectorOauthStateColumns } from "../columns/connector-oauth-state";

/** Application mapping for member-owned connector authorization sessions. */
export const connectorOauthStates = pgTable(
  "connector_oauth_states",
  connectorOauthStateColumns(),
);
