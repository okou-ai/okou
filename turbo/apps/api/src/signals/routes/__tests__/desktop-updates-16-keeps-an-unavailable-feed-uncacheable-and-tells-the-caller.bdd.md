# desktop-updates-16-keeps-an-unavailable-feed-uncacheable-and-tells-the-caller

## desktop-updates-16-keeps-an-unavailable-feed-uncacheable-and-tells-the-caller-001

- Vitest: "desktop update routes > keeps an unavailable feed uncacheable and tells the caller to retry"
- Mode: run
- Given: The release manifest is unavailable because its upstream request fails at the transport boundary, and the API has no cached copy.
- When: An unauthenticated macOS ARM64 Desktop updater sends `GET /api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml`.
- Then: The API responds with HTTP 503, `Cache-Control: no-store`, and `Retry-After: 60`.
