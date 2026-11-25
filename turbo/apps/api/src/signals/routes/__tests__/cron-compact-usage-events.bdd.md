# cron-compact-usage-events

## cron-compact-usage-events-001

- Vitest: "usage event compaction cron > requires the cron secret"
- Mode: run
- Given: The usage event compaction cron requires a configured secret.
- When: The caller requests `GET /api/cron/compact-usage-events` without authorization.
- Then: The API returns HTTP 401 with code `UNAUTHORIZED` and message `Invalid cron secret`.

## cron-compact-usage-events-002

- Vitest: "usage event compaction cron > rejects the wrong cron secret"
- Mode: run
- Given: The usage event compaction cron requires a configured secret.
- When: The caller requests `GET /api/cron/compact-usage-events` with an incorrect bearer secret.
- Then: The API returns HTTP 401 with code `UNAUTHORIZED` and message `Invalid cron secret`.
