import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  HalloweenStoredQuestions,
  HalloweenSnapshot,
} from "../jsonb-contracts/halloween";

export const halloweenRounds = pgTable(
  "halloween_2026_rounds",
  {
    id: uuid("id").primaryKey(),
    // Kept nullable until the preceding anonymous-round API has drained. New
    // account-owned rounds do not use this retired bearer credential.
    tokenHash: text("token_hash"),
    questions: jsonb("questions").$type<HalloweenStoredQuestions>().notNull(),
    questionIndex: integer("question_index").notNull().default(0),
    correct: integer("correct").notNull().default(0),
    selectedId: text("selected_id"),
    outcome: text("outcome")
      .$type<"playing" | "success" | "wrong" | "left" | "interrupted">()
      .notNull()
      .default("playing"),
    userId: text("user_id"),
    orgId: text("org_id"),
    email: text("email"),
    // Compatibility-only until the preceding association API has drained.
    linkedAt: timestamp("linked_at"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => {
    return [
      index("halloween_2026_rounds_user").on(t.userId, t.startedAt),
      index("halloween_2026_rounds_interrupted").on(t.outcome, t.updatedAt),
      check("halloween_2026_rounds_correct", sql`${t.correct} between 0 and 5`),
      check(
        "halloween_2026_rounds_question_index",
        sql`${t.questionIndex} between 0 and 4`,
      ),
    ];
  },
);

export const halloweenBatches = pgTable("halloween_2026_batches", {
  id: uuid("id").primaryKey(),
  capturedAt: timestamp("captured_at").notNull(),
  capturedBy: text("captured_by").notNull(),
  participants: jsonb("participants").$type<HalloweenSnapshot>().notNull(),
});

export const halloweenReviews = pgTable("halloween_2026_reviews", {
  userId: text("user_id").primaryKey(),
  batchId: uuid("batch_id")
    .notNull()
    .references(() => {
      return halloweenBatches.id;
    }),
  decision: text("decision").$type<"winner" | "not_selected">().notNull(),
  reviewedBy: text("reviewed_by").notNull(),
  reviewedAt: timestamp("reviewed_at").notNull().defaultNow(),
  notifiedAt: timestamp("notified_at"),
  rewardedAt: timestamp("rewarded_at"),
});
