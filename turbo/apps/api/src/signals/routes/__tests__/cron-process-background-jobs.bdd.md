# cron-process-background-jobs

## cron-process-background-jobs-001

- Vitest: "GET /api/cron/process-background-jobs > rejects a missing cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller sends no authorization header.
- When: The caller requests `GET /api/cron/process-background-jobs`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## cron-process-background-jobs-002

- Vitest: "GET /api/cron/process-background-jobs > rejects an invalid cron secret"
- Mode: run
- Given: The platform cron secret is configured and the caller presents a different bearer secret.
- When: The caller requests `GET /api/cron/process-background-jobs` with `Authorization: Bearer wrong-secret`.
- Then: The API responds with HTTP 401 and exactly `{ error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } }`.

## cron-process-background-jobs-003

- Vitest: "GET /api/cron/process-background-jobs > fails closed when source-only preparation has no delivery configuration"
- Mode: run
- Given: The cron caller holds the valid cron secret, and neither the marketing rewards events origin nor its secret is configured.
- When: The caller requests `GET /api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=25`.
- Then: The API responds with HTTP 503 and error code `EVENT_DELIVERY_UNAVAILABLE`.

## cron-process-background-jobs-004

- Vitest: "GET /api/cron/process-background-jobs > rejects a preparation batch above its fixed bound"
- Mode: run
- Given: The cron caller holds the valid cron secret.
- When: The caller requests `GET /api/cron/process-background-jobs?marketingRewardsOnly=true&maxRewardEvents=101`.
- Then: The API responds with HTTP 400.
