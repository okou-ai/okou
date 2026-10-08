-- Step 2 (#36955) already seeded all live and still-heartbeating terminal rows.
-- Keep only the newest active run slotted per thread before enforcing uniqueness;
-- older duplicate rows remain visible by run ID, but no longer own the slot.
UPDATE "active_agent_runs" AS "active"
SET "chat_thread_id" = NULL
WHERE "active"."chat_thread_id" IS NOT NULL
  AND "active"."run_id" <> (
    SELECT "candidate_active"."run_id"
    FROM "active_agent_runs" AS "candidate_active"
    INNER JOIN "agent_runs" AS "candidate"
      ON "candidate"."id" = "candidate_active"."run_id"
    WHERE "candidate_active"."chat_thread_id" = "active"."chat_thread_id"
    ORDER BY "candidate"."created_at" DESC, "candidate"."id" DESC
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX "active_agent_runs_chat_thread_unique" ON "active_agent_runs" USING btree ("chat_thread_id");
