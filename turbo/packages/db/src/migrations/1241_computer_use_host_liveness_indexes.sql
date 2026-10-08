-- vm0:non-transactional
-- Every host query filters by token hash or (org_id, user_id) first, so this
-- index is never used, yet heartbeats and claim polls update last_seen_at and
-- had to maintain it on every write. Dropping it lets those updates stay HOT.
DROP INDEX CONCURRENTLY IF EXISTS "idx_computer_use_hosts_last_seen";
--> statement-breakpoint
-- Claim polls no longer lock the host row, so one running command per host is
-- enforced by this partial unique index instead. Production had a single
-- running command when this was written, so the build cannot hit duplicates.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_computer_use_commands_running_host" ON "computer_use_commands" USING btree ("host_id") WHERE status = 'running';
