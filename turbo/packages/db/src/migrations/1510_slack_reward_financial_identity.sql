-- okou:non-transactional
-- Retry an interrupted build without removing an already-valid financial invariant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_index
    WHERE indexrelid = to_regclass('public.uq_credit_expires_slack_reward_org')
      AND NOT indisvalid
  ) THEN
    DROP INDEX "uq_credit_expires_slack_reward_org";
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_credit_expires_slack_reward_org" ON "credit_expires_record" USING btree ("org_id") WHERE source = 'get_started_reward';
