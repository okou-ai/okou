import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { hostedSites } from "./hosted-site";
import type { HostedDomainVerification } from "../jsonb-contracts/hosted-site-domain";

export const hostedSiteDomains = pgTable(
  "hosted_site_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    hostname: text("hostname").notNull(),
    revision: uuid("revision").notNull().defaultRandom(),
    challenge: text("challenge").notNull(),
    challengeExpiresAt: timestamp("challenge_expires_at", {
      withTimezone: true,
    }).notNull(),
    providerId: text("provider_id"),
    // Once a provider operation may have started, deletion must reconcile it.
    providerStarted: boolean("provider_started").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    verification: jsonb("verification").$type<HostedDomainVerification>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => {
    return [
      index("idx_hosted_site_domains_site").on(table.siteId),
      unique("hosted_site_domains_site_id_id").on(table.siteId, table.id),
      uniqueIndex("hosted_site_domains_site_hostname")
        .on(table.siteId, table.hostname)
        .where(sql`${table.releasedAt} IS NULL`),
      uniqueIndex("hosted_site_domains_verified_hostname")
        .on(table.hostname)
        .where(
          sql`${table.verifiedAt} IS NOT NULL AND ${table.releasedAt} IS NULL`,
        ),
      uniqueIndex("hosted_site_domains_provider_id").on(table.providerId),
    ];
  },
);

export const hostedSiteDomainSettings = pgTable(
  "hosted_site_domain_settings",
  {
    siteId: uuid("site_id")
      .primaryKey()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    selectedDomainId: uuid("selected_domain_id"),
    revision: uuid("revision").notNull().defaultRandom(),
  },
  (table) => {
    return [
      foreignKey({
        columns: [table.siteId, table.selectedDomainId],
        foreignColumns: [hostedSiteDomains.siteId, hostedSiteDomains.id],
      }),
    ];
  },
);
