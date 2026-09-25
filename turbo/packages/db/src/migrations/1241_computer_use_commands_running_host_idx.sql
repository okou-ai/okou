-- vm0:non-transactional
-- Claim polls no longer lock the host row, so one running command per host is
-- enforced by this partial unique index instead. Production had a single
-- running command when this was written, so the build cannot hit duplicates.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "idx_computer_use_commands_running_host" ON "computer_use_commands" USING btree ("host_id") WHERE status = 'running';
