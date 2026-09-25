-- vm0:non-transactional
-- Every host query filters by token hash or (org_id, user_id) first, so this
-- index is never used, yet heartbeats and claim polls update last_seen_at and
-- had to maintain it on every write. Dropping it lets those updates stay HOT.
DROP INDEX CONCURRENTLY IF EXISTS "idx_computer_use_hosts_last_seen";
