import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { hostedSites } from "./hosted-site";

/** Named viewers and invitations, independent of the site's general audience. */
export const hostedSiteShares = pgTable(
  "hosted_site_shares",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    email: text("email").notNull(),
    // A pending invitation is claimed only through a live, verified Clerk email.
    userId: text("user_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("hosted_site_shares_site_email").on(table.siteId, table.email),
    ];
  },
);
