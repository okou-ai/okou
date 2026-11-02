-- okou:non-transactional
-- Remove an invalid index left by an interrupted concurrent build before retrying.
DROP INDEX CONCURRENTLY IF EXISTS "uq_credit_expires_slack_reward_org";
--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY "uq_credit_expires_slack_reward_org" ON "credit_expires_record" USING btree ("org_id") WHERE source = 'get_started_reward';
