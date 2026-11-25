# cron-retain-chat-events

## cron-retain-chat-events-001

- Vitest: "requires the cron secret"
- Mode: run
- Intent: review
- Given: The chat event retention cron has a configured secret and the caller supplies no authorization header.
- When: The caller sends `GET /api/cron/retain-chat-events`.
- Then: The API responds with HTTP 401, error code `UNAUTHORIZED`, and message `Invalid cron secret`.
