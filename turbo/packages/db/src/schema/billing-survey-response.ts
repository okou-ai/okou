import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Where in the paid funnel a one-question survey was asked:
 * - `credits_exhausted`: a member without a paid plan ran out of credits and
 *   was offered the upgrade.
 * - `checkout_abandoned`: a member created a Stripe Checkout session and came
 *   back without completing it.
 */
export const BILLING_SURVEY_KINDS = [
  "credits_exhausted",
  "checkout_abandoned",
] as const;

export type BillingSurveyKind = (typeof BILLING_SURVEY_KINDS)[number];

/**
 * One answer per member per survey. The unique index makes a repeated submit
 * (double click, second tab) a no-op, so each member is asked only once and a
 * reward can never be granted twice for the same answer.
 */
export const billingSurveyResponses = pgTable(
  "billing_survey_responses",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    survey: varchar("survey", { length: 32 })
      .$type<BillingSurveyKind>()
      .notNull(),
    answer: varchar("answer", { length: 32 }).notNull(),
    /** Optional free text, only kept for the `other` answer. */
    detail: text("detail"),
    /** Which checkout was abandoned (`plan`, `credits`, …), when known. */
    checkoutKind: varchar("checkout_kind", { length: 32 }),
    /** Bonus credits granted for this answer; 0 when none were granted. */
    rewardCredits: integer("reward_credits").notNull().default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("uq_billing_survey_responses_member").on(
        table.orgId,
        table.userId,
        table.survey,
      ),
      index("idx_billing_survey_responses_survey_created").on(
        table.survey,
        table.createdAt,
      ),
      check(
        "chk_billing_survey_responses_survey",
        sql`${table.survey} IN ('credits_exhausted', 'checkout_abandoned')`,
      ),
      check(
        "chk_billing_survey_responses_reward",
        sql`${table.rewardCredits} >= 0`,
      ),
    ];
  },
);
