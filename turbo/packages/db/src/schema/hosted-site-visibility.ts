import { check, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { hostedSites } from "./hosted-site";

/** Only explicit owner changes create a policy; publication creation stays public. */
export const hostedSiteVisibility = pgTable(
  "hosted_site_visibility",
  {
    siteId: uuid("site_id")
      .primaryKey()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    visibility: text("visibility")
      .$type<"private" | "organization" | "public">()
      .notNull(),
    revision: uuid("revision").notNull(),
  },
  (table) => {
    return [
      check(
        "hosted_site_visibility_audience",
        sql`${table.visibility} IN ('private', 'organization', 'public')`,
      ),
    ];
  },
);
