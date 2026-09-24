import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";

/**
 * Official shared AgentPhone user links.
 *
 * The shared AgentPhone number is global: one external handle (E.164 phone
 * for SMS/MMS, or phone or email Apple ID for iMessage) can connect to
 * exactly one active internal account/org at a time.
 */
export const agentphoneUserLinks = pgTable(
  "agentphone_user_links",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phoneHandle: varchar("phone_handle", { length: 254 }).notNull(),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    /**
     * Retired: current APIs neither read nor write it and rely on the
     * `okou` default; drop it after older API deployments drain.
     */
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("okou")
      .notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_agentphone_user_links_phone_handle").on(
        table.phoneHandle,
      ),
      uniqueIndex("idx_agentphone_user_links_user_org").on(
        table.userId,
        table.orgId,
      ),
      index("idx_agentphone_user_links_org").on(table.orgId),
    ];
  },
);
