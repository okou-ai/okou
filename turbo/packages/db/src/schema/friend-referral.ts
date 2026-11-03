import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const friendReferralLinks = pgTable(
  "friend_referral_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_friend_referral_link_owner").on(
        table.orgId,
        table.userId,
      ),
    ];
  },
);

/** Registration attribution and its financial receipt survive repeat purchases. */
export const friendReferrals = pgTable(
  "friend_referrals",
  {
    inviteeUserId: text("invitee_user_id").primaryKey(),
    linkId: uuid("link_id")
      .notNull()
      .references(() => {
        return friendReferralLinks.id;
      }),
    registeredAt: timestamp("registered_at").notNull(),
    paidOrgId: text("paid_org_id"),
    stripeInvoiceId: text("stripe_invoice_id"),
    creditGrantId: uuid("credit_grant_id"),
    grantedAt: timestamp("granted_at"),
    expiresAt: timestamp("expires_at"),
  },
  (table) => {
    return [
      index("idx_friend_referrals_link").on(table.linkId),
      uniqueIndex("uq_friend_referral_credit_grant").on(table.creditGrantId),
      check(
        "chk_friend_referral_grant",
        sql`
      (${table.grantedAt} IS NULL AND ${table.expiresAt} IS NULL AND ${table.creditGrantId} IS NULL AND ${table.stripeInvoiceId} IS NULL AND ${table.paidOrgId} IS NULL)
      OR (${table.grantedAt} IS NOT NULL AND ${table.expiresAt} = ${table.grantedAt} + interval '1 month'
        AND ${table.expiresAt} IS NOT NULL AND ${table.creditGrantId} IS NOT NULL AND ${table.stripeInvoiceId} IS NOT NULL AND ${table.paidOrgId} IS NOT NULL)`,
      ),
    ];
  },
);
