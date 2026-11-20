import { pgTable } from "drizzle-orm/pg-core";
import { connectorExternalCodeSessionColumns } from "../columns/connector-external-code-session";

/** Application mapping for member-owned connector authorization sessions. */
export const builtinConnectorExternalCodeSessions = pgTable(
  "connector_external_code_sessions",
  connectorExternalCodeSessionColumns(),
);
