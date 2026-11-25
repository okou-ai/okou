# built-in-generation

## built-in-generation-001

- Vitest: "GET /api/built-in-generations/:generationId > marks stale active jobs as failed when status is read"
- Mode: run
- Given: An onboarded member with purchased credits has an active provider-backed image generation accepted 16 minutes ago.
- When: The owner sends `GET /api/built-in-generations/:generationId`.
- Then: HTTP 200 identifies the image as failed with the current completion timestamp, code `GENERATION_TIMEOUT` and message `Generation timed out. Please try again.` Realtime receives a failed image update for that generation ID.

## built-in-generation-002

- Vitest: "GET /api/built-in-generations/:generationId > leaves active jobs running before the timeout window"
- Mode: run
- Given: An onboarded member with purchased credits has an active provider-backed image generation accepted 14 minutes ago.
- When: The owner sends `GET /api/built-in-generations/:generationId`.
- Then: HTTP 200 identifies the image as running with null completion time, and no realtime update is published.
