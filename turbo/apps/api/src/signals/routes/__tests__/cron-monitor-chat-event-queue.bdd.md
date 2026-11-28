# cron-monitor-chat-event-queue

## cron-monitor-chat-event-queue-001

- Vitest: "cron monitor chat event queue > requires the cron secret"
- Mode: run
- Intent: review
- Given: The chat event queue monitoring cron has a configured secret and the caller supplies no authorization header.
- When: The caller sends `GET /api/cron/monitor-chat-event-queue`.
- Then: The API responds with HTTP 401, error code `UNAUTHORIZED`, and message `Invalid cron secret`.
