import { pgTable, text, uuid, varchar } from "drizzle-orm/pg-core";
import { connectorSkillBundleColumns } from "../columns/connector-skill-bundle";

// Narrow runtime projection of published Skill content and its captured source.
// The retained source-ID column also supports preceding claim readers.
export const orgCustomConnectorSkillBundles = pgTable("org_custom_connectors", {
  id: uuid("id").primaryKey(),
  orgId: text("org_id").notNull(),
  skillStorageVersionId: varchar("skill_storage_version_id", { length: 64 }),
  ...connectorSkillBundleColumns(),
});
