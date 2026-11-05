import { uuid, varchar, text, boolean, timestamp } from "drizzle-orm/pg-core";

/** Shared, independently owned Teams account columns. */
export function teamsOrgConnectionColumns() {
  return {
    id: uuid("id").defaultRandom().primaryKey(),
    teamsUserId: varchar("teams_user_id", { length: 255 }),
    teamsAadObjectId: varchar("teams_aad_object_id", { length: 255 }),
    teamsTenantId: varchar("teams_tenant_id", { length: 255 }).notNull(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    teamsUserDisplayName: varchar("teams_user_display_name", { length: 255 }),
    teamsUserPrincipalName: varchar("teams_user_principal_name", {
      length: 255,
    }),
    dmWelcomeSent: boolean("dm_welcome_sent").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  };
}
