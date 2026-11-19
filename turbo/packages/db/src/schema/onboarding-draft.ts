import type { StoredOnboardingDraft } from "@okouai/db/jsonb-contracts/onboarding-draft";
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const onboardingDrafts = pgTable(
  "onboarding_drafts",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    payload: jsonb("payload").$type<StoredOnboardingDraft>().notNull(),
    revision: uuid("revision").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId] }),
    index("idx_onboarding_drafts_expires_at").on(table.expiresAt),
  ],
);
