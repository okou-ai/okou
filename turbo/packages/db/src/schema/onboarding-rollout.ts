import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Each rollout's migration records when new accounts become eligible. */
export const onboardingRollouts = pgTable("onboarding_rollouts", {
  name: text("name").primaryKey(),
  activatedAt: timestamp("activated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
