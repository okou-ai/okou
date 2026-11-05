import { pgTable, uuid } from "drizzle-orm/pg-core";
import { connectorSkillBundleColumns } from "../columns/connector-skill-bundle";

// Narrow runtime projection of independently owned preparation metadata.
// The complete migration schema retains its outgoing Storage foreign key.
export const orgCustomConnectorSkillBundles = pgTable("org_custom_connectors", {
  id: uuid("id").primaryKey(),
  ...connectorSkillBundleColumns(),
});
